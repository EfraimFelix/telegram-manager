# Telegram Manager

An English-language SaaS for moderating Telegram groups with explicit community rules and TypeSafe Jev judgments.

## What is included

- Next.js 15 App Router dashboard and Better Auth email/password sessions
- Drizzle ORM with PostgreSQL migrations
- Telegram bot connection, community permission checks, and webhook registration
- TypeSafe Jev evaluation with one typed probability per enabled rule
- Deterministic NOUL classification, warning progression, Telegram actions, audit log, feedback, quotas, and idempotent processing
- Amplify Gen 2 infrastructure: Lambda Function URL, SQS with DLQ, worker Lambda, Aurora Serverless v2 Data API, Secrets Manager, alarms, and an SSR compute role

## Local development

Node 22 and pnpm are required.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`, create an account, and sign in. The dashboard can run without Telegram or TypeSafe credentials; those credentials are needed only for their respective live integrations. Connecting a real bot locally also requires a public HTTPS URL in `WEBHOOK_BASE_URL`.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` runs both the moderation tests and the synthesized AWS infrastructure assertions. No AWS credentials are required for these checks.

## AWS deployment

See [docs/aws-deployment.md](docs/aws-deployment.md) for the architecture, cost tradeoffs, permissions, deployment sequence, and operational steps. Deployment requires an AWS account, a TypeSafe API key, and a Telegram bot; the repository does not contain credentials.
