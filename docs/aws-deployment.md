# AWS deployment

Infrastructure is defined in `amplify/backend.ts` and `amplify/infrastructure.ts`. These files do not deploy on import except through an explicitly invoked Amplify deployment. No deployment is needed to run the infrastructure tests.

## Architecture and cost

Telegram → public Lambda Function URL → webhook → standard SQS → worker → Telegram. The worker and Next.js SSR access the application's existing PostgreSQL database through `DATABASE_URL`; this stack does not create Aurora, RDS, a VPC, database credentials, or Data API permissions.

The configured database must be reachable from the Lambda worker and Amplify SSR runtime over its PostgreSQL endpoint. Its provider is responsible for database backups, networking, availability, and cost. Keep `DATABASE_URL` server-only: it must never use the `NEXT_PUBLIC_` prefix or be exposed to the browser.

The main queue retains messages for four days; after five failed receives, SQS moves them to the 14-day DLQ. The worker has a 60-second timeout, 360-second visibility, batch size one, partial batch responses, and maximum/reserved concurrency two. Both functions use Node 22/ARM64 and 256 MB initially. Profile real workloads before increasing limits. Standard SQS is at-least-once and unordered: the worker deduplicates each chat/message/revision tuple and makes moderation side effects retry-safe.

## Integration contracts

Production entry files are supplied by the application: `src/functions/webhook.ts` and `src/functions/worker.ts`, both exporting `handler`. CDK bundles their dependencies with the repository lockfile. Infrastructure tests instead bundle a small fixture; those tests do not verify application handler behavior.

The webhook receives only `APP_SECRET_ARN` and `QUEUE_URL`; it can read the application secret and send to SQS. It validates the bot-specific secret, parses the update, and enqueues the normalized message without accessing PostgreSQL. The worker receives `DATABASE_URL` and `APP_SECRET_ARN`; it consumes SQS, persists idempotently, evaluates NOUL judgments, resolves warning progression deterministically, and executes Telegram actions. SSR receives `DATABASE_URL` from its server-only `.env.production` file, along with `WEBHOOK_BASE_URL`; it has application-secret read access but no SQS grant.

The Function URL uses `NONE` authentication. The handler validates Telegram's secret-token header, rejects inappropriate methods/payloads, and returns success only after SQS accepts the update. `NONE` does not authenticate Telegram and incurs invocation costs even for rejected requests. Validation and enqueueing use no DB access, so the webhook timeout remains deliberately short. Infrastructure failures are rethrown so Telegram gets a 5xx retry response and Lambda records an error. Worker failures return the failed SQS `messageId` in `batchItemFailures`; partial failures do not increase Lambda's `Errors` metric, so queue-age and DLQ alarms monitor this path instead.

`custom.runtime` in `amplify_outputs.json` contains exactly:

```text
appSecretArn, queueUrl, webhookBaseUrl, computeRoleArn
```

`scripts/write-runtime-config.mjs` reads this object plus an explicit `BETTER_AUTH_URL` and generates `.env.production`. The build then appends `DATABASE_URL` from the protected Amplify branch environment. The generated file stays in the server deployment artifact, is not committed, and must never be exposed through `NEXT_PUBLIC_`. Use a canonical HTTPS origin for `BETTER_AUTH_URL`, set separately for each Amplify branch.

## Secrets and credentials

The application secret starts as `{ "key": "<64 generated alphanumeric characters>", "typesafeApiKey": "" }`. After an authorized deployment, edit **only** `typesafeApiKey` in Secrets Manager, preserving `key`. The runtime uses `key` for authentication and SHA-256 hashes it into the 32-byte AES key. Infrastructure does not implement that derivation. Rotating/replacing `key` without a data migration invalidates sessions and can make existing encrypted bot tokens unreadable. Restart or expire application secret caches after changing the TypeSafe key.

Store `DATABASE_URL` as a protected branch environment variable in Amplify. Use a dedicated, least-privileged PostgreSQL user; rotate its password through the database provider and update the Amplify variable. AWS credentials are not required for database access, so never place permanent AWS keys in Amplify variables or build artifacts.

## Deployment prerequisites and sequence

1. Use the checked-in Next.js 15 version: AWS currently documents Amplify Hosting SSR support through 15. Use Node 22 for builds. Commit dependencies and the lockfile, including `aws-cdk-lib` 2.270.x, compatible Amplify packages, `tsx`, and an accessible `esbuild` binary. This project currently obtains esbuild through its installed tooling; keep it available for CDK's local bundling.
2. Set branch `DATABASE_URL` and `BETTER_AUTH_URL` in Amplify Hosting. The database URL must be a valid `postgres://` or `postgresql://` connection string to the application's existing database, and the provider must accept connections from Amplify and Lambda.
3. The Amplify build/deployment service role needs the Gen 2 deployment permissions. It needs no RDS Data API permissions. The SSR role is not the build role.
4. Once deployment is authorized, the supplied `amplify.yml` installs dependencies, checks infrastructure, deploys the backend, generates runtime config, runs the application's `scripts/migrate.ts` using `DATABASE_URL`, and builds `.next`. Migration failures block the frontend build; use forward-compatible migrations because the old frontend can remain live.
5. Attach `custom.runtime.computeRoleArn` in **Amplify → App settings → IAM roles → Compute role**, preferably to the specific branch. This separate association is required; creating the role in the backend does not attach it to Hosting. Do not give production database access to untrusted preview branches. The trust principal is `amplify.amazonaws.com`. SSR will obtain temporary credentials without explicit keys or manual STS code.
6. Populate `typesafeApiKey`, confirm DB migrations and SSR runtime configuration, then configure the official Telegram bot with `TELEGRAM_SYSTEM_BOT_TOKEN` using `pnpm telegram:configure-system-bot`. The command validates the bot, stores its encrypted credential in `bot_connections`, derives a stable bot-specific webhook secret from the application key, and registers the generated Function URL. Do not point Telegram at the Amplify SSR domain. Users connect groups from the dashboard through a short-lived `startgroup` link; they do not provide bot tokens or chat IDs.
7. Subscribe an operator-controlled destination to the SNS topic from the custom stack's `AlarmsTopicArn` CloudFormation output. Three alarms cover webhook errors, source-queue age, and visible DLQ messages. There are no recipients until a subscription is created and confirmed. Inspect/replay DLQ messages only after fixing the underlying issue.

Backend creation, migration, compute-role attachment, and webhook registration are separate operational steps; this change performs none of them.

## Local verification

```sh
pnpm exec tsc --project amplify/tsconfig.json
pnpm exec tsx --test amplify/tests/*.test.ts
```

These checks use no AWS credentials or AWS API calls. CDK assertions verify that no RDS or EC2 resources are provisioned, plus public invocation permissions, SQS retries/concurrency, scoped SSR grants, retained secrets, the output contract, and alarm actions. Runtime-config tests check the allowlist and reject missing values and dotenv injection.

The application secret and both queues are retained on stack removal. The stack creates no database resources. Keep production identifiers/construct paths stable. Log groups are deleted with the stack and otherwise retain 14 days.

## CDK pitfalls and official references

- Since October 2025 new Function URLs require **both** `lambda:InvokeFunctionUrl` (condition `FunctionUrlAuthType=NONE`) and `lambda:InvokeFunction` (condition `InvokedViaFunctionUrl=true`). CDK 2.270's `addFunctionUrl` generates both. Tests guard against regression; do not add an unrestricted public `InvokeFunction` grant. [Lambda URL policies](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).
- [Amplify custom CDK resources](https://docs.amplify.aws/react/build-a-backend/add-aws-services/custom-resources/), [SSR compute role](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html), [SSR environment configuration](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html), [Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html).
- [SQS event-source configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [Telegram webhook secret](https://core.telegram.org/bots/api#setwebhook).
