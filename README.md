# Keanu Reviews — GitHub → Slack PR Bot
<p align="center">
<img width="512" height="512" alt="keanu-reviews-pixel-neon-bar" src="https://github.com/user-attachments/assets/33e7acc7-f7c2-4aee-bd8f-cda8e51a97ac" />
</p>

A self-hosted, one-way **GitHub → Slack** pull-request bot. It
gives every pull request its own Slack channel and mirrors the PR's lifecycle
into Slack so reviewers can discuss, get reminded, and see status without leaving
Slack.

The bot **only ever writes to Slack** and makes **read-only** GitHub calls
(REST + OAuth). Nothing typed in Slack is written back to GitHub — the PR stays
the single source of truth. The one optional exception is a merge comment (see
[Optional GitHub write](#optional-github-write-merge-comment)), which is off by
default.

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [GitHub App setup](#github-app-setup)
- [Slack app setup](#slack-app-setup)
- [Feature reference](#feature-reference)
- [Operations](#operations)
- [Development](#development)
- [Deployment](#deployment)
- [License](#license)

## Features

- **One channel per PR.** A channel is created when a PR is first seen and named
  `‹state›-‹number›-‹author›-‹repo›-‹title›` (e.g. `pr-1423-octocat-acme-api-add-auth`),
  slugified to Slack's constraints. The name tracks the PR's state (`draft` → `pr` →
  `closed`/`merged`) via rename, and the channel is archived on close/merge.
- **Author + reviewer invites.** The PR author and each requested reviewer are
  invited to the channel once their GitHub↔Slack identity is known.
- **Comment & review mirroring.** Inline review comments (with file/line deep
  links) and PR conversation comments are mirrored into the channel, **authored
  as the commenter's linked Slack user** (their name + avatar) rather than the
  bot. Comments post top-level in the channel; a **reply** within a GitHub review
  thread is posted as a Slack **threaded reply** under the original comment
  (configurable via `THREAD_COMMENTS`), mirroring GitHub's own threading.
- **Mergeability status.** Posts a line when a PR becomes ready to merge, blocked,
  or has conflicts — only when the state changes. The "behind the base branch"
  state is intentionally not announced (a noisy update-your-branch nudge).
- **Review reminders.** If a requested review is still pending after a
  configurable delay (default 12h), the reviewer gets one reminder — delivered
  only during a configurable daily window, **on weekdays only**. Reminders stop
  once the PR has `REMINDER_SUPPRESS_APPROVALS` approvals (default 1): no ping
  to the remaining reviewers, and no reminder in the PR channel.
- **`#shipped` announcement.** Optionally announces each merge into a channel of
  your choice.
- **Allow-listed bots.** Bot accounts are filtered out by default (deploy-preview
  noise); you can allow specific review bots (e.g. Pullfrog) by login. An allowed
  bot's review summary is threaded under the PR root and its HTML/marketing cruft
  is stripped.
- **Quiet archiving (optional).** With per-user Slack OAuth, the bot archives
  channels **silently** — no "archived the channel" notifications — by having
  participants leave on their own token first (the way Axolo does it).
- **Self-healing & durable.** Every webhook is acknowledged fast and processed by
  a background worker with retries. Channel operations recover automatically from
  a bot that was removed (`not_in_channel`) or a channel that was archived
  (`is_archived`).

## How it works

```
GitHub App webhook  ──►  /webhooks/github  ──►  jobs table  ──►  worker  ──►  Slack Web API
   (pull_request,        verify signature,      (durable,        (one job      (create/rename/
    review, comment,     authorize install,      at-least-once)   per PR at     archive/invite/
    check_run, …)        dedupe, enqueue)                         a time,       post messages)
                                                                  retries)
```

- **Ack-fast, process-async.** The webhook route verifies the signature,
  authorizes the installation, deduplicates the delivery, persists a job, and
  returns `2xx` well within GitHub's timeout. A worker processes the job later, so
  slow Slack calls never trigger GitHub retries.
- **Idempotent & ordered.** PR state is a function of the latest known facts, not
  event arrival order, and every Slack side effect is keyed so retries and
  redeliveries never double-post.
- **One writer per PR.** Every write to a PR's channel runs inside one PR session:
  a per-PR lane in the process and a database lease across replicas. Jobs for
  different PRs run in parallel (`WORKER_CONCURRENCY`); jobs for one PR run one
  at a time, in arrival order.
- **One-way boundary.** The bot reads GitHub and writes Slack. It never mutates
  GitHub except the opt-in merge comment.

## Requirements

- **Node.js 20+** (developed on Node 24) and **pnpm**.
- A **PostgreSQL** database (any Postgres works; the reference deployment uses a
  managed Postgres).
- A **GitHub App** installed on the org/repos you want mirrored.
- A **Slack app** (bot token) in the workspace that will host PR channels.
- A public HTTPS origin GitHub and Slack can reach (`PUBLIC_URL`).

## Quick start

```bash
pnpm install
cp .env.example .env      # fill in the values below
pnpm db:migrate           # apply schema to DATABASE_URL
pnpm dev                  # start with reload
```

Verify it's up:

```bash
curl localhost:3000/health   # process liveness  -> {"status":"ok",...}
curl localhost:3000/ready    # database + required-schema readiness
```

For a click-by-click walkthrough of creating the GitHub App and Slack app, see
[`SETUP.md`](SETUP.md). The sections below are the reference.

## Configuration

All configuration comes from environment variables, is **validated at boot**, and
the process refuses to start if anything required is missing or malformed (see
[`src/config/env.ts`](src/config/env.ts)). Secrets are read from the environment (on a
managed host, from its secret store) and are **never written to logs**. See
[`.env.example`](.env.example) for a copy-paste template.

### Required

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | Numeric GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM, newlines preserved). **Secret.** |
| `GITHUB_WEBHOOK_SECRET` | Shared secret that signs webhook deliveries. **Secret.** |
| `GITHUB_INSTALLATION_ID` | The single installation ID allowed to reach this service. |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub App OAuth client ID (for `/link-github`). |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub App OAuth client secret. **Secret.** |
| `OAUTH_STATE_SECRET` | Independent random value ≥ 32 chars, signs OAuth state and image URLs. Rotating it breaks images already posted to Slack. **Secret.** |
| `PUBLIC_URL` | Public HTTPS origin, no path (HTTP allowed only for loopback). |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). **Secret.** |
| `SLACK_SIGNING_SECRET` | Slack signing secret (verifies slash commands). **Secret.** |
| `SLACK_TEAM_ID` | The one allowed Slack workspace ID (`T…`). |
| `DATABASE_URL` | PostgreSQL connection URL. **Secret.** |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. |
| `PORT` | `3000` | HTTP port. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `SLACK_SHIPPED_CHANNEL` | _(off)_ | Channel ID or name that gets a "shipped" note on merge. |
| `GITHUB_COMMENT_ON_MERGE` | `false` | Opt-in: post the Slack channel URL on the merged PR (the only GitHub write). |
| `THREAD_COMMENTS` | `true` | Thread a review-comment reply under the original comment's Slack message (`false` keeps all comments flat). |
| `ALLOWED_BOTS` | _(none)_ | Comma-separated bot logins to mirror (e.g. `pullfrog`). |
| `WORKER_CONCURRENCY` | `4` | Jobs the worker runs at once. Jobs for the same PR always run one at a time. |
| `REMINDER_HOURS` | `12` | Hours a review can be pending before one reminder fires. |
| `REMINDER_SUPPRESS_APPROVALS` | `1` | Approvals that stop reminders for that PR (reviewers and the channel). |
| `REMINDER_SCAN_INTERVAL_MS` | `60000` | How often the reminder scanner runs. |
| `REMINDER_WINDOW_START_HOUR` | `5` | Delivery window start hour (inclusive). |
| `REMINDER_WINDOW_END_HOUR` | `14` | Delivery window end hour (exclusive). |
| `REMINDER_WINDOW_TZ` | `America/New_York` | IANA time zone the window and weekday check use. |
| `SLACK_OAUTH_CLIENT_ID` | _(off)_ | Quiet archiving: Slack OAuth client ID. |
| `SLACK_OAUTH_CLIENT_SECRET` | _(off)_ | Quiet archiving: Slack OAuth client secret. **Secret.** |
| `SLACK_USER_TOKEN_ENC_KEY` | _(off)_ | Quiet archiving: 32-byte key (hex/base64) encrypting stored user tokens. **Secret.** |

The three `SLACK_OAUTH_*` / `SLACK_USER_TOKEN_ENC_KEY` values enable [quiet
archiving](#quiet-archiving-optional) and must be set **all together or none** —
a partial configuration refuses to boot.

## GitHub App setup

Point the App's webhook URL at `${PUBLIC_URL}/webhooks/github`, choose
`application/json` content type, and use the same random secret you put in
`GITHUB_WEBHOOK_SECRET`. Subscribe to these events:

- Pull requests
- Pull request reviews
- Pull request review comments
- Issue comments
- Check runs

Grant **read-only** repository permissions for **Pull requests**, **Issues**, and
**Checks** (plus GitHub's mandatory read-only **Metadata**). Set the installation
ID in `GITHUB_INSTALLATION_ID`; events from any other installation are rejected.

For account linking, create an OAuth client on the App and set its callback URL to
exactly `${PUBLIC_URL}/oauth/github/callback`.

### Optional GitHub write (merge comment)

Setting `GITHUB_COMMENT_ON_MERGE=true` makes the bot post the Slack channel URL as
a comment on each merged PR — the **only** exception to the one-way boundary. It's
**off by default**. To use it, change **Pull requests** permission to **Read &
write** and reinstall the App; otherwise the comment POST returns `403`.

## Slack app setup

### Bot token scopes

`channels:manage`, `channels:read`, `channels:join`, `channels:write.invites`,
`chat:write`, `chat:write.customize`, `users:read.email` (add the `groups:*`
equivalents if you later use private channels).

- `channels:join` lets the bot re-join a channel it manages but was removed from.
- `channels:manage` lets it create, rename, archive, and **unarchive** channels —
  the last of which lets it recover a channel that was archived out from under it
  instead of getting stuck.
- `chat:write.customize` lets a mirrored comment be **authored as the linked Slack
  user** (their name + avatar). Without it, comments post as the bot with a
  "by &lt;login&gt;" label instead.
- `users:read.email` (which implies `users:read`) powers email-based identity
  resolution, reviewer display names, and comment authorship (name + avatar).

Register the slash command **`/link-github`** with request URL
`${PUBLIC_URL}/slack/commands`, and set `SLACK_TEAM_ID` to your `T…` workspace ID.

> **After changing scopes you must reinstall the app**, or Slack keeps issuing the
> old token without the new scope (`missing_scope` errors).

### Quiet archiving (optional)

See [Quiet archiving](#quiet-archiving-optional) below for the extra user scope,
redirect URL, and `/link-slack` command.

## Feature reference

### Channel lifecycle & naming

Channels are named `‹state›-‹number›-‹author›-‹repo-slug›-‹title-slug›`, lowercased
and trimmed to Slack's 80-char limit. The author is the PR author's GitHub login, or
`unknown` when GitHub sends none. The `‹state›-‹number›-‹author›-‹repo›` prefix
uniquely identifies a PR. State, number, and author are never trimmed, a very long
repo slug is cut to fit, and the title takes whatever room is left. A later title
edit simply renames the channel. On close/merge the channel
is archived; on reopen it is unarchived and renamed back.

Existing channels keep the naming scheme they were created with, so a channel
created as `pr-acme-api-1423-add-auth` or `pr-octocat-acme-api-1423-add-auth` keeps
that layout through every later rename and archive.

### GitHub account linking

`/link-github` never trusts a typed username. With no arguments it returns an
ephemeral GitHub authorization link. After GitHub verifies the account, the
browser shows a short-lived one-time code; the same Slack user runs
`/link-github confirm <code>` to finish. The signed OAuth state is single-use, the
code is bound to the originating workspace and Slack user, and an existing GitHub
mapping cannot be transferred to another Slack user through this flow.

Administrators can also bulk-seed verified mappings from CSV or JSON:

```csv
github_login,slack_email,slack_user_id
octocat,octocat@example.com,
hubot,,U01234567
```

```bash
pnpm admin:import-identities -- ./identities.csv
```

Each row needs a GitHub login and either a Slack email or Slack user ID. The
command resolves the login through GitHub to store its immutable account ID,
resolves email through Slack when needed, and prints JSON counts without echoing
identity data. Imports are idempotent.

### Review reminders

When a review is requested, a reminder is scheduled `REMINDER_HOURS` out and
cancelled if the reviewer responds, the request is withdrawn, or the PR closes.
Every still-pending reminder for that PR is also cancelled once it is ready to
merge or has at least `REMINDER_SUPPRESS_APPROVALS` approvals (default 1). At
that point the bot posts nothing: remaining reviewers are not pinged, and the
PR channel does not get a reminder. A PR with fewer approvals keeps the usual
reminder.

Reminders are delivered only **on weekdays** during the daily window
`[REMINDER_WINDOW_START_HOUR, REMINDER_WINDOW_END_HOUR)` evaluated in
`REMINDER_WINDOW_TZ` (DST-aware). A reminder that comes due outside the window or
on a weekend waits until the window next opens.

### Images in comments and reviews

Images in human-authored comments and reviews appear under the mirrored message.
GitHub's own link to a pasted screenshot expires after five minutes, so Slack is
given `${PUBLIC_URL}/github-attachments/<signature>/<id>.<png|jpg|gif>` instead,
which fetches the image from GitHub anonymously on every request. The route serves
only URLs the bot signed, with a key derived from `OAUTH_STATE_SECRET`, so
rotating that secret breaks every image already posted to Slack. Slack only
embeds png, jpeg, and gif, so an svg, video, webp, or deleted attachment appears
as a link to GitHub. A private-repo attachment is a link too, because GitHub
won't serve it anonymously. If Slack refuses an image, the message still posts,
with its images as links.

### Allow-listed bots

Bot accounts (`type: "Bot"`) are filtered out of mirroring by default. List a
bot's login in `ALLOWED_BOTS` (comma-separated) to surface it — matching ignores
case and GitHub's `[bot]` suffix, so `pullfrog` matches `pullfrog[bot]`. An
allowed bot's **review summary** is **threaded under the PR root** to reduce
noise, and its body is cleaned of HTML comments, `<sup>` marketing footers, and
logo images before rendering. Never list your own App's bot login, or it would
echo its own merge comments.

### Quiet archiving (optional)

Archiving a channel makes Slack notify every member ("_… archived the channel_"),
and kicking members first is worse (each gets "_you were removed by …_"). To
archive silently — like Axolo — the bot instead makes each participant **leave**
on their own token before archiving; a self-leave is silent, and once no humans
remain, the archive notifies nobody. Members who haven't authorized are simply
left in place (they get the one archive notice), so the flow degrades gracefully.

Enable it by setting `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, and
`SLACK_USER_TOKEN_ENC_KEY` (all three). Then, in the Slack app:

1. Add the **`channels:write` _user_ scope** (User Token Scopes) and reinstall —
   the only user scope needed; it lets `conversations.leave` remove a user from a
   public channel.
2. Add the redirect URL `${PUBLIC_URL}/oauth/slack/callback`.
3. Register the slash command **`/link-slack`** → `${PUBLIC_URL}/slack/commands`.

Each teammate runs `/link-slack` once and approves. Tokens are stored encrypted at
rest (AES-256-GCM); a revoked token is dropped automatically.

## Operations

### Health & readiness

- `GET /health` — process liveness.
- `GET /ready` — verifies database reachability and that every required table and
  column exists (returns `503` if the schema isn't migrated).

### Database migrations

```bash
pnpm db:generate   # generate a migration from src/db/schema.ts
pnpm db:migrate    # apply pending migrations to DATABASE_URL
pnpm db:push       # push the schema directly (dev shortcut)
```

Migrations are checked into `src/db/migrations/`. `db:migrate` reads
`DATABASE_URL`; export it (or your `.env`) before running.

### Replaying a failed job

Jobs retry with backoff and, after exhausting the budget, land in `failed` with
their payload retained. Reset one to be reprocessed:

```bash
pnpm jobs:replay -- <failed-job-id>
```

The command loads the same configuration as the service, so run it where the
service's environment is set.

### Self-healing

The service repairs these states without an operator:

- **Channel state.** A write that finds the bot removed rejoins (`not_in_channel`),
  and a write to an archived channel unarchives it (`is_archived`). Posts made
  with an author's token get the same recovery, and fall back to the bot when
  Slack refuses the token.
- **Missing channel.** A review, review comment, or PR conversation comment on a
  PR with no channel builds the channel first.
- **Out-of-order comments.** A comment deleted before it was mirrored is never
  posted. A reply whose parent is still posting waits briefly, then threads
  under it. An edit or delete that Slack refuses with the author's token retries
  as the bot.
- **Review alerts.** A review-request alert that was never posted is posted by
  the reminder scan instead of a reminder. A reminder that ran out of attempts
  does not block the next request. A failed Slack profile read falls back to the
  GitHub login.
- **Rate limits.** A GitHub rate limit retries the job at GitHub's reset time
  (at most 15 minutes).
- **Stuck work.** A job handler that runs past 100 seconds is stopped and retried.
  A job whose lease another worker took stops writing. Lifecycle locks left by a
  crash are removed by the daily prune.
- **Process faults.** An unhandled rejection or uncaught exception is logged,
  in-flight work drains, and the process exits `1` so its supervisor restarts it.
  Jobs are durable, so a restart loses nothing.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run locally with reload. |
| `pnpm typecheck` | TypeScript check (`tsc --noEmit`). |
| `pnpm test` | Run the Vitest suite. |
| `pnpm lint` | Biome lint + format check. |
| `pnpm format` | Biome format (write). |
| `pnpm db:generate` / `db:migrate` / `db:push` | Drizzle schema tooling. |
| `pnpm admin:import-identities -- <file>` | Bulk-import GitHub↔Slack identities. |
| `pnpm jobs:replay -- <id>` | Reset a failed job for retry. |

Tests run fully offline against an in-memory Postgres (PGlite) and a fake Slack
client, so no live credentials are needed. `src/integration.test.ts` exercises the
full webhook → worker → Slack wiring end to end.

**Project layout:**

```
src/
  lib/               domain-free primitives: errors, clock, logger, token cipher
  config/            boot-time config validation
  db/                Drizzle schema, migrations, connection, readiness
  events/            GitHub webhook payloads parsed into typed domain events
  github/            App auth, OAuth, REST fetchers, webhook verification
  slack/             Slack Web API gateway, message catalog, delivery ledger
  identity/          GitHub↔Slack identity, user tokens, linking routes
  reminders/         per-reviewer reminder state
  pr/                pull request rows, the per-PR session and its channel writer
  mirror/            comments and reviews mirrored into the PR channel as their author
  reviews/           review-request alerts, check runs, the reminder scan
  queue/             durable job queue and the worker
  ingest/            GitHub webhook route
  app/               the service context, HTTP app, background loops, event → handler table
  admin/             operator CLIs (identity import, job replay, reconcile)
  index.ts           entry point: config, context, server, loops, shutdown
```

Each module is imported through its `#name` barrel, and
`src/architecture.test.ts` enforces the layer order and table ownership.

## Deployment

Run it as a single long-running Node service on any host (a managed Node
platform, a container, etc.). Provide the environment variables from
[Configuration](#configuration) via the host's secret store, run `pnpm db:migrate`
against your database once per deploy, and expose `PUBLIC_URL` over HTTPS so GitHub
and Slack can reach the webhook and OAuth/command endpoints. Point liveness probes
at `/health` and readiness probes at `/ready`.

## License

[MIT](LICENSE)
