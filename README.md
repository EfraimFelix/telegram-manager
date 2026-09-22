# Telegram Manager

An English-language SaaS for moderating Telegram groups with explicit community rules and TypeSafe Jev judgments.

## What is included

- Next.js 15 App Router dashboard and Better Auth email/password sessions
- Drizzle ORM with PostgreSQL migrations
- Official Telegram bot connection, automatic group discovery, community permission checks, and webhook registration
- TypeSafe Jev evaluation with one typed probability per enabled rule
- Deterministic NOUL classification, warning progression, Telegram actions, audit log, feedback, quotas, and idempotent processing
- Amplify Gen 2 infrastructure: Lambda Function URL, SQS with DLQ, worker Lambda, Secrets Manager, alarms, and an SSR compute role; PostgreSQL is supplied through `DATABASE_URL`

## Local development

Node 22 and pnpm are required.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`, create an account, and sign in. The dashboard can run without Telegram or TypeSafe credentials; those credentials are needed only for their respective live integrations. Connecting the official bot locally requires `TELEGRAM_SYSTEM_BOT_TOKEN` and a public HTTPS URL in `WEBHOOK_BASE_URL`.

Configure the shared bot after the database is available:

```bash
TELEGRAM_SYSTEM_BOT_TOKEN=... pnpm telegram:configure-system-bot
```

The dashboard then creates a short-lived Telegram `startgroup` link. The user selects a group, grants the bot administrator permissions, and confirms the discovered group in the dashboard. A custom bot connection remains represented internally for future use but is not exposed by the dashboard.

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
