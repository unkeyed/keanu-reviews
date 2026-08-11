# Unkey Slack PR Bot

A self-hosted, one-way **GitHub → Slack** bot (axolo.co-style): one Slack channel per pull request, with state-tracking channel names, auto-archiving, reviewer invites, review-comment mirroring with file/line deep links, CI reporting, and 12-hour review reminders. Nothing typed in Slack is ever written back to GitHub — the PR stays the system of record.

Full design: [`docs/plans/2026-08-11-001-feat-github-slack-pr-bot-plan.md`](docs/plans/2026-08-11-001-feat-github-slack-pr-bot-plan.md).

## Stack

- **Runtime:** TypeScript + [Hono](https://hono.dev), a long-running Node service on **Unkey Deploy**.
- **Storage:** PlanetScale Postgres (via Drizzle — added in U2).
- **Inbound:** GitHub App webhooks; a Slack `/link-github` slash command (U9).
- **Outbound:** Slack Web API only.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in secrets (see below)
pnpm dev               # start with reload
```

Verify the service is up:

```bash
curl localhost:3000/health   # -> {"status":"ok",...}
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run locally with reload |
| `pnpm typecheck` | TypeScript check (`tsc --noEmit`) |
| `pnpm test` | Run the Vitest suite |
| `pnpm lint` | Biome lint + format check |
| `pnpm db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` (drizzle-kit) |
| `pnpm db:push` | Push the schema directly (dev shortcut) |

## Configuration

All config is validated at boot and the process refuses to start if anything
required is missing (see `src/config.ts`). Secrets are loaded from the
environment — on Unkey Deploy, from the platform secret store — and are never
written to logs. See [`.env.example`](.env.example) for the full list.

Required secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_INSTALLATION_IDS` (allowlist),
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL`.

### Slack app scopes

`channels:manage`, `channels:write.invites`, `chat:write`, `users:read.email`
(add `chat:write.public` if the bot does not auto-join channels; `groups:*` for
private channels, deferred). The `/link-github` command needs slash-command
interactivity plus the signing secret.

## Status

All nine Implementation Units (U1–U9) are implemented and unit/integration
tested against an in-memory Postgres (PGlite) and a fake Slack client:
scaffold, database layer, webhook ingestion + auth, PR→channel lifecycle,
reviewer invites + identity, comment/permalink mirroring, CI reporting, the
12h reminder scheduler, and the `/link-github` identity population path.

Two live gates from the plan's Verification Contract remain and require real
credentials: applying migrations to a PlanetScale branch, and the end-to-end
smoke against a real Slack workspace + GitHub App. The offline end-to-end test
(`src/integration.test.ts`) exercises the full webhook → worker → Slack wiring.
