# Unkey Slack PR Bot

A self-hosted, one-way **GitHub → Slack** bot (axolo.co-style): one Slack channel per pull request, with state-tracking channel names, auto-archiving, reviewer invites, review-comment mirroring with file/line deep links, CI reporting, and 12-hour review reminders. The bot writes to Slack and makes read-only GitHub REST/OAuth calls; it never mutates GitHub. Nothing typed in Slack is written back to GitHub — the PR stays the system of record.

Full design: [`docs/plans/2026-08-11-001-feat-github-slack-pr-bot-plan.md`](docs/plans/2026-08-11-001-feat-github-slack-pr-bot-plan.md).

## Stack

- **Runtime:** TypeScript + [Hono](https://hono.dev), a long-running Node service on **Unkey Deploy**.
- **Storage:** PlanetScale Postgres (via Drizzle — added in U2).
- **Inbound:** GitHub App webhooks; a Slack `/link-github` slash command (U9).
- **Outbound:** Slack Web API writes and user lookup; read-only GitHub REST/OAuth calls.

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in secrets (see below)
pnpm dev               # start with reload
```

Verify the service is up:

```bash
curl localhost:3000/health   # process liveness -> {"status":"ok",...}
curl localhost:3000/ready    # database + required-schema readiness
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
| `pnpm admin:import-identities -- <file.csv\|file.json>` | Import verified GitHub-to-Slack identities |
| `pnpm jobs:replay <failed-job-id>` | Reset one failed job with retained payload for retry |

## Configuration

All config is validated at boot and the process refuses to start if anything
required is missing (see `src/config.ts`). Secrets are loaded from the
environment — on Unkey Deploy, from the platform secret store — and are never
written to logs. See [`.env.example`](.env.example) for the full list.

Required secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_INSTALLATION_ID` (one installation),
`GITHUB_OAUTH_CLIENT_SECRET`, `OAUTH_STATE_SECRET`, `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `DATABASE_URL`. The service also requires the GitHub App
OAuth client ID, its public origin, and the one allowed Slack workspace ID; see
`.env.example` for their variable names.

### GitHub App setup

Configure the GitHub App webhook URL as `${PUBLIC_URL}/webhooks/github`, choose
`application/json` as the content type, and enter the same random signing secret
stored in `GITHUB_WEBHOOK_SECRET`. Subscribe to these events:

- Pull requests
- Pull request reviews
- Pull request review comments
- Issue comments
- Check runs

Grant read-only repository permissions for **Pull requests**, **Issues**, and
**Checks** (plus GitHub's mandatory read-only **Metadata** permission). The bot
does not need any GitHub write permission. Set the installation ID in
`GITHUB_INSTALLATION_ID`; events from other installations are rejected.

### GitHub account linking

`/link-github` never trusts a typed GitHub username. With no arguments it returns
an ephemeral GitHub authorization link without waiting on database or network
I/O. After GitHub verifies the account, the browser shows a short-lived one-time
code; return to the same Slack user and run
`/link-github confirm <code>` to finish. The signed OAuth state is single-use,
the code is bound to the originating workspace and Slack user, and the callback
does not link anything by itself. Existing GitHub mappings cannot be transferred
to another Slack user through this flow.

In the GitHub App settings, create a client secret and set the callback URL to
exactly `${PUBLIC_URL}/oauth/github/callback` (for example,
`https://bot.example.com/oauth/github/callback`). Set `PUBLIC_URL` to an HTTPS
origin with no path (HTTP is accepted only for loopback development), and
generate a separate random `OAUTH_STATE_SECRET` of at least 32 characters. Set
`SLACK_TEAM_ID` to the `T…` workspace ID that owns the slash command.

Administrators can also seed mappings from a UTF-8 CSV or JSON file after all
production environment variables are set:

```csv
github_login,slack_email,slack_user_id
octocat,octocat@example.com,
hubot,,U01234567
```

```bash
pnpm admin:import-identities -- ./identities.csv
```

JSON input is an array with the same `github_login`, `slack_email`, and
`slack_user_id` string fields. Each row needs a GitHub login and either a Slack
email or user ID. The command resolves the login through GitHub to store its
immutable account ID, resolves email through Slack when needed, and prints JSON
counts for imported and skipped rows without echoing identity data. Imports are
idempotent and safe to rerun; invalid files or invocations exit nonzero.

### Slack app scopes

`channels:manage`, `channels:read`, `channels:join`, `channels:write.invites`,
`chat:write`, `users:read.email` (`groups:*` for private channels, deferred).
`channels:join` lets the bot re-join a channel it manages but was removed from,
or one recovered by name, so posting/inviting there recovers from
`not_in_channel` instead of failing. The `/link-github` command needs
slash-command interactivity plus the signing secret; its request URL is
`${PUBLIC_URL}/slack/commands`.

> **After adding or changing scopes you must reinstall the app** to the
> workspace, or Slack keeps issuing the old token without the new scope
> (`missing_scope` errors).

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
