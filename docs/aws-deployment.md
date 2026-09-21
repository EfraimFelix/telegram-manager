# AWS deployment

Infrastructure is defined in `amplify/backend.ts` and `amplify/infrastructure.ts`. These files do not deploy on import except through an explicitly invoked Amplify deployment. No deployment is needed to run the infrastructure tests.

## Architecture and cost

Telegram → public Lambda Function URL → webhook → standard SQS → worker → Telegram/Data API. Next.js SSR calls Data API and Secrets Manager directly using an Amplify SSR compute role; there is no application API Lambda, AppSync, or API Gateway.

Aurora PostgreSQL 16.13 uses one Serverless v2 writer, 0–2 ACUs, and a five-minute idle pause. Its two subnets are private and isolated; there are no NAT gateways, Internet gateways, VPC endpoints, readers, or RDS Proxy. Lambdas run outside this VPC, reaching Data API and Telegram over HTTPS. The DB security group has no ingress rules. This is not a public PostgreSQL endpoint.

Storage, I/O, backups beyond the allowance, Secrets Manager, CloudWatch alarms/logs, SNS notifications, and SQS polling can still cost money while DB compute is paused. Continuous traffic prevents auto-pause. Resuming usually takes about 15 seconds, and can take 30+ seconds after a long pause. Handle `DatabaseResumingException` with bounded retries and jitter. Do not add database health polling. The 2-ACU ceiling and single writer trade throughput and fast failover for lower cost.

The main queue retains messages for four days; after five failed receives, SQS moves them to the 14-day DLQ. The worker has a 60-second timeout, 360-second visibility, batch size one, partial batch responses, and maximum/reserved concurrency two. Both functions use Node 22/ARM64 and 256 MB initially. Profile real workloads before increasing limits. Standard SQS is at-least-once and unordered: the worker deduplicates each chat/message/revision tuple and makes moderation side effects retry-safe.

## Integration contracts

Production entry files are supplied by the application: `src/functions/webhook.ts` and `src/functions/worker.ts`, both exporting `handler`. CDK bundles their dependencies with the repository lockfile. Infrastructure tests instead bundle a small fixture; those tests do not verify application handler behavior.

The webhook receives only `APP_SECRET_ARN` and `QUEUE_URL`; it can read the application secret and send to SQS. It validates the bot-specific secret, parses the update, and enqueues the normalized message without accessing Aurora. The worker receives `DB_RESOURCE_ARN`, `DB_SECRET_ARN`, `DB_NAME`, and `APP_SECRET_ARN`; it consumes SQS, persists idempotently, evaluates rules, and executes the policy. Only SSR receives `WEBHOOK_BASE_URL`, avoiding a self-reference from the webhook URL into its own function. SSR has Data API and both secret-read grants, but no SQS grant.

The Function URL uses `NONE` authentication. The handler validates Telegram's secret-token header, rejects inappropriate methods/payloads, and returns success only after SQS accepts the update. `NONE` does not authenticate Telegram and incurs invocation costs even for rejected requests. Validation and enqueueing use no DB access: the 15-second timeout is deliberately short, and a paused Aurora lookup could exceed it. Infrastructure failures are rethrown so Telegram gets a 5xx retry response and Lambda records an error. Worker failures return the failed SQS `messageId` in `batchItemFailures`; partial failures do not increase Lambda's `Errors` metric, so queue-age and DLQ alarms monitor this path instead.

`custom.runtime` in `amplify_outputs.json` contains exactly:

```text
region, dbResourceArn, dbSecretArn, dbName, appSecretArn,
queueUrl, webhookBaseUrl, computeRoleArn
```

`scripts/write-runtime-config.mjs` reads this object plus an explicit `BETTER_AUTH_URL` and generates `.env.production`. It writes only `AWS_REGION`, `DB_RESOURCE_ARN`, `DB_SECRET_ARN`, `DB_NAME`, `APP_SECRET_ARN`, `WEBHOOK_BASE_URL`, and `BETTER_AUTH_URL`. It never retrieves secrets, copies the entire build environment, or emits AWS access keys. Use a canonical HTTPS origin for `BETTER_AUTH_URL`, set separately for each Amplify branch. Do not commit the generated environment file or expose these server values through `NEXT_PUBLIC_`.

## Secrets and credentials

The application secret starts as `{ "key": "<64 generated alphanumeric characters>", "typesafeApiKey": "" }`. After an authorized deployment, edit **only** `typesafeApiKey` in Secrets Manager, preserving `key`. The runtime uses `key` for authentication and SHA-256 hashes it into the 32-byte AES key. Infrastructure does not implement that derivation. Rotating/replacing `key` without a data migration invalidates sessions and can make existing encrypted bot tokens unreadable. Restart or expire application secret caches after changing the TypeSafe key.

`DatabaseSecret` creates retained database username/password JSON for Data API and is attached to the cluster through `Credentials.fromSecret`. Do not replace it with a plaintext password or the application secret. `database.grantDataApiAccess(role)` grants the SQL API actions on this cluster and read access to its attached DB secret. App-secret read is a separate grant. Data API needs both IAM permissions and `secretArn`; `iamAuthentication`/`rds-db:connect` are not substitutes. This lean setup uses the cluster administrator for the application; before stricter production isolation, create an application SQL user/secret and reserve admin credentials for migrations.

AWS SDK clients should use the default credential provider chain: runtime role credentials in Lambda/SSR, and a local profile/SSO for development. Never put permanent AWS keys or secret values in Amplify environment variables or build artifacts.

## Deployment prerequisites and sequence

1. Use the checked-in Next.js 15 version: AWS currently documents Amplify Hosting SSR support through 15. Use Node 22 for builds. Commit dependencies and the lockfile, including `aws-cdk-lib` 2.270.x, compatible Amplify packages, `tsx`, and an accessible `esbuild` binary. This project currently obtains esbuild through its installed tooling; keep it available for CDK's local bundling.
2. Choose an AWS region supporting **both** Aurora PostgreSQL 16.13 Serverless v2/Data API and Lambda Function URLs. Check actual engine availability in that account/region before the first deployment. This configuration has not been validated against an AWS account.
3. Set branch `BETTER_AUTH_URL` in Amplify Hosting. The Amplify build/deployment service role needs the Gen 2 deployment permissions. Database migrations additionally require `rds-data:ExecuteStatement`, `BatchExecuteStatement`, `BeginTransaction`, `CommitTransaction`, and `RollbackTransaction` on the cluster ARN plus `secretsmanager:GetSecretValue` on the DB-secret ARN (and KMS decrypt if changing to a customer-managed key). The SSR role is not the build role.
4. Once deployment is authorized, the supplied `amplify.yml` installs dependencies, checks infrastructure, deploys the backend, generates runtime config, runs the application's `scripts/migrate.ts`, and builds `.next`. The migration script is supplied separately by the application and must use Data API; the command loads `.env.production` explicitly. On the first deployment, if migration permissions are not yet configured for the newly generated ARNs, the build will fail at migrations after backend creation. Attach the scoped permissions to the build role and rerun. Migration failures must block the frontend build; use forward-compatible migrations because the old frontend can remain live.
5. Attach `custom.runtime.computeRoleArn` in **Amplify → App settings → IAM roles → Compute role**, preferably to the specific branch. This separate association is required; creating the role in the backend does not attach it to Hosting. Do not give production database access to untrusted preview branches. The trust principal is `amplify.amazonaws.com`. SSR will obtain temporary credentials without explicit keys or manual STS code.
6. Populate `typesafeApiKey`, confirm DB migrations and SSR runtime configuration, then connect the Telegram bot through the dashboard. The application derives a stable bot-specific webhook secret from the application key and registers the generated Function URL. Do not point Telegram at the Amplify SSR domain.
7. Subscribe an operator-controlled destination to the SNS topic from the custom stack's `AlarmsTopicArn` CloudFormation output. Three alarms cover webhook errors, source-queue age, and visible DLQ messages. There are no recipients until a subscription is created and confirmed. Inspect/replay DLQ messages only after fixing the underlying issue.

Backend creation, migration, compute-role attachment, and webhook registration are separate operational steps; this change performs none of them.

## Local verification

```sh
pnpm exec tsc --project amplify/tsconfig.json
pnpm exec tsx --test amplify/tests/*.test.ts
```

These checks use no AWS credentials or AWS API calls. CDK assertions verify the database capacity, network isolation, both public invocation permissions, SQS retries/concurrency, scoped SSR grants, retained secrets, output contract, and alarm actions. Runtime-config tests check the allowlist and reject missing values, mismatched regions, and dotenv injection.

Database, both secrets, and both queues are retained on stack removal; database deletion protection is enabled. A removed branch/sandbox therefore can leave billable resources. Keep production identifiers/construct paths stable. Cleanup is an explicit manual operation after deciding what data to preserve. Log groups are deleted with the stack and otherwise retain 14 days.

## CDK pitfalls and official references

- Use `DatabaseCluster` + `ClusterInstance.serverlessV2`, not the Serverless v1 `ServerlessCluster`. The current APIs are `serverlessV2MinCapacity`, `serverlessV2MaxCapacity`, `serverlessV2AutoPauseDuration`, and `enableDataApi`. If using `AuroraPostgresEngineVersion.of(...)` instead of a supported constant, include `{ serverlessV2AutoPauseSupported: true }` only for an engine version that actually supports it. Older CDK versions may reject zero or lack these properties. [Cluster API](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.DatabaseClusterProps.html), [engine feature metadata](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.AuroraPostgresEngineFeatures.html), [credentials](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.Credentials.html).
- Since October 2025 new Function URLs require **both** `lambda:InvokeFunctionUrl` (condition `FunctionUrlAuthType=NONE`) and `lambda:InvokeFunction` (condition `InvokedViaFunctionUrl=true`). CDK 2.270's `addFunctionUrl` generates both. Tests guard against regression; do not add an unrestricted public `InvokeFunction` grant. [Lambda URL policies](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).
- [Amplify custom CDK resources](https://docs.amplify.aws/react/build-a-backend/add-aws-services/custom-resources/), [SSR compute role](https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html), [SSR environment configuration](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html), [Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html).
- [Aurora auto-pause and billing limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html), [Data API regional support](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.Data_API.html), [Data API authorization](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html), [SQS event-source configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html), [Telegram webhook secret](https://core.telegram.org/bots/api#setwebhook).
