# First-time setup

This guide takes you from nothing to a working GitHub → Slack PR bot: the GitHub
App, the Slack app, all OAuth pieces, every environment variable and where each
value comes from, the database, and how to verify it works.

Follow the sections **in order** — later steps reuse values from earlier ones.
Plan for ~30 minutes.

- [0. Before you start](#0-before-you-start)
- [1. Pick your public URL and generate secrets](#1-pick-your-public-url-and-generate-secrets)
- [2. Database (PostgreSQL)](#2-database-postgresql)
- [3. Create the GitHub App](#3-create-the-github-app)
- [4. Create the Slack app](#4-create-the-slack-app)
- [5. Fill in `.env`](#5-fill-in-env)
- [6. Run and verify](#6-run-and-verify)
- [7. Link identities (so mentions/invites work)](#7-link-identities-so-mentionsinvites-work)
- [8. Optional features](#8-optional-features)
- [9. Deploy](#9-deploy)
- [10. Troubleshooting](#10-troubleshooting)
- [Environment variable reference](#environment-variable-reference)

---

## 0. Before you start

You need:

- **Node ≥ 22** and **pnpm** (`npm i -g pnpm`).
- A **public HTTPS URL** that reaches this service. GitHub and Slack must be able
  to POST to it. For production use your real host (a managed Node platform, container, etc.). For local
  testing, run a tunnel: `ngrok http 3000` and use the `https://…ngrok…` URL.
- Admin access to a **GitHub organization** (to create + install a GitHub App).
- Admin access to a **Slack workspace** (to create + install a Slack app).
- A **PostgreSQL** database for `DATABASE_URL` (any Postgres provider works).

Install dependencies once:

```bash
pnpm install
cp .env.example .env
```

Keep `.env` open — you'll fill it in as you go.

---

## 1. Pick your public URL and generate secrets

**`PUBLIC_URL`** is the HTTPS origin of this service, **with no path** (e.g.
`https://pr-bot.example.com`). Three inbound endpoints hang off it — you'll paste
these into GitHub and Slack in the next steps:

| Endpoint | Consumer | Set in |
| --- | --- | --- |
| `PUBLIC_URL/webhooks/github` | GitHub App webhook | Step 3 |
| `PUBLIC_URL/oauth/github/callback` | GitHub OAuth (account linking) | Step 3 |
| `PUBLIC_URL/slack/commands` | Slack `/link-github` + `/link-slack` commands | Step 4 |
| `PUBLIC_URL/oauth/slack/callback` | Slack OAuth (quiet archiving, optional) | Step 4.2b |

> `PUBLIC_URL` must be `https://` with no path/query (plain `http://` is allowed
> only for `localhost` during local dev).

Generate two random secrets now and paste them into `.env`:

```bash
openssl rand -hex 32   # -> GITHUB_WEBHOOK_SECRET
openssl rand -hex 32   # -> OAUTH_STATE_SECRET   (must be >= 32 chars)
```

---

## 2. Database (PostgreSQL)

1. Create a PostgreSQL database (any provider).
2. Copy its connection string into **`DATABASE_URL`** in `.env`
   (e.g. `postgres://user:pass@host:5432/dbname?sslmode=require`).
3. Apply the schema:

   ```bash
   pnpm db:migrate
   ```

   (`pnpm db:push` is a quicker dev alternative that syncs the schema directly.)

---

## 3. Create the GitHub App

GitHub → your org **Settings → Developer settings → GitHub Apps → New GitHub App**.

### 3.1 Basics + webhook

- **GitHub App name:** anything (e.g. `Acme PR Bot`).
- **Homepage URL:** your `PUBLIC_URL` is fine.
- **Webhook → Active:** ✅
- **Webhook URL:** `PUBLIC_URL/webhooks/github`
- **Webhook secret:** the `GITHUB_WEBHOOK_SECRET` you generated in Step 1.

### 3.2 Repository permissions (read-only by default)

Set these to **Read-only**:

- **Pull requests** — Read-only
- **Issues** — Read-only
- **Checks** — Read-only
- **Metadata** — Read-only (mandatory, auto-selected)

> The bot is read-only by design. The **only** exception is the optional
> merge-comment feature (Step 8.2), which needs **Pull requests: Read & write**.
> Leave everything read-only unless you plan to enable it.

### 3.3 Subscribe to events

Check these under **Subscribe to events**:

- Pull request
- Pull request review
- Pull request review comment
- Issue comment
- Check run

### 3.4 OAuth (for `/link-github`)

Under **Identifying and authorizing users**:

- **Callback URL:** `PUBLIC_URL/oauth/github/callback` (exactly)
- Leave "Request user authorization (OAuth) during installation" unchecked.

### 3.5 Create the app, then collect credentials

Click **Create GitHub App**. On the app's **General** page, collect:

| Value on the page | `.env` variable |
| --- | --- |
| **App ID** | `GITHUB_APP_ID` |
| **Client ID** | `GITHUB_OAUTH_CLIENT_ID` |
| **Client secrets → Generate a new client secret** | `GITHUB_OAUTH_CLIENT_SECRET` |
| **Private keys → Generate a private key** (downloads a `.pem`) | `GITHUB_APP_PRIVATE_KEY` (paste the full file contents, including the `-----BEGIN/END-----` lines) |

> Multi-line private key in `.env`: keep the newlines. Most process managers
> accept a quoted multi-line value; on a managed host paste it into the secret
> store as-is.

### 3.6 Install the app + get the installation ID

- **Install App** (left nav) → install on your org → choose the repos to watch.
- After installing, open the installation's config page. The number at the end of
  the URL is your installation ID:

  ```
  https://github.com/organizations/<org>/settings/installations/12345678
                                                                 ^^^^^^^^  = GITHUB_INSTALLATION_ID
  ```

Set **`GITHUB_INSTALLATION_ID`** (a single numeric id). Events from any other
installation are rejected.

---

## 4. Create the Slack app

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**,
pick your workspace.

### 4.1 Bot token scopes

**OAuth & Permissions → Scopes → Bot Token Scopes**, add all of:

- `channels:manage`
- `channels:read`
- `channels:join`
- `channels:write.invites`
- `chat:write`
- `users:read.email`

(For private PR channels later you'd also add the `groups:*` equivalents — not
needed for the default public-channel setup.)

### 4.2 Slash command

**Slash Commands → Create New Command:**

- **Command:** `/link-github`
- **Request URL:** `PUBLIC_URL/slack/commands`
- **Short description:** "Link your GitHub account"

### 4.2b (Optional) Quiet archiving via `/link-slack`

Skip this section unless you want channels archived with **no** notification to
members (see "Quiet archiving" in the README for why this needs a per-user
token). If you skip it, channels still archive — members just get Slack's one
"archived the channel" notice.

1. **OAuth & Permissions → Scopes → User Token Scopes**, add `channels:write`
   (this is the only user scope; it lets the bot make a user leave a channel).
2. **OAuth & Permissions → Redirect URLs**, add `PUBLIC_URL/oauth/slack/callback`.
3. **Slash Commands → Create New Command:**
   - **Command:** `/link-slack`
   - **Request URL:** `PUBLIC_URL/slack/commands` (same endpoint as `/link-github`)
   - **Short description:** "Enable quiet archiving of PR channels"
4. **Basic Information → App Credentials**: copy **Client ID** →
   `SLACK_OAUTH_CLIENT_ID` and **Client Secret** → `SLACK_OAUTH_CLIENT_SECRET`.
5. Generate a 32-byte key for `SLACK_USER_TOKEN_ENC_KEY` (encrypts stored user
   tokens at rest): `openssl rand -hex 32`.

All three env vars must be set together or the service refuses to boot. Each
teammate then runs `/link-slack` once and approves.

### 4.3 Install to workspace + collect credentials

**Install App → Install to Workspace**, approve, then collect:

| Where | `.env` variable |
| --- | --- |
| **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`) | `SLACK_BOT_TOKEN` |
| **Basic Information → App Credentials → Signing Secret** | `SLACK_SIGNING_SECRET` |
| Your **workspace ID** (`T…`) | `SLACK_TEAM_ID` |

To find the workspace ID quickly:

```bash
curl -s -H "Authorization: Bearer xoxb-YOUR-BOT-TOKEN" https://slack.com/api/auth.test
# read "team_id": "T0123ABCD"
```

> **After changing scopes you must reinstall the app** (Install App → Reinstall),
> or Slack keeps issuing the old token without the new scopes (`missing_scope`).

---

## 5. Fill in `.env`

By now `.env` should have everything below filled. Minimum required set:

```bash
# GitHub App
GITHUB_APP_ID=            # Step 3.5
GITHUB_APP_PRIVATE_KEY=   # Step 3.5 (.pem contents)
GITHUB_WEBHOOK_SECRET=    # Step 1 (openssl)
GITHUB_OAUTH_CLIENT_ID=   # Step 3.5
GITHUB_OAUTH_CLIENT_SECRET=  # Step 3.5
GITHUB_INSTALLATION_ID=   # Step 3.6

# OAuth / public origin
OAUTH_STATE_SECRET=       # Step 1 (openssl, >= 32 chars)
PUBLIC_URL=               # Step 1 (https origin, no path)

# Slack app
SLACK_BOT_TOKEN=          # Step 4.3 (xoxb-…)
SLACK_SIGNING_SECRET=     # Step 4.3
SLACK_TEAM_ID=            # Step 4.3 (T…)

# Storage
DATABASE_URL=             # Step 2
```

Optional — set all three to enable quiet archiving (Step 4.2b):

```bash
SLACK_OAUTH_CLIENT_ID=       # Step 4.2b (Client ID)
SLACK_OAUTH_CLIENT_SECRET=   # Step 4.2b (Client Secret)
SLACK_USER_TOKEN_ENC_KEY=    # Step 4.2b (openssl rand -hex 32)
```

See the [full reference](#environment-variable-reference) for the optional ones.

---

## 6. Run and verify

```bash
pnpm dev
```

Health checks:

```bash
curl localhost:3000/health   # process liveness -> {"status":"ok",...}
curl localhost:3000/ready    # DB + schema readiness
```

Make sure your `PUBLIC_URL` actually routes to the running process (tunnel up, or
deployed). Then **open a test PR** in a watched repo. Within a few seconds you
should see:

- a new channel named like `pr-<repo-slug>-<number>-<title-slug>`
  (e.g. `pr-unkey-api-6949-configure-amp-orb-setup-and-service-portals`), with a
  **topic** like `PR 6949: octocat wants to merge into main from feature/x`,
- an opening message describing the PR,
- the author invited (once they're linked — see Step 7).

Request a review, push commits (CI), merge — each drives channel activity.

---

## 7. Link identities (so mentions/invites work)

Reviewer/author **mentions and channel invites only work for linked users.** The
map starts empty. Populate it two ways:

- **Self-service:** anyone runs `/link-github` in Slack. It returns a GitHub
  authorization link; after they approve, they run `/link-github confirm <code>`
  to finish. (This is why the GitHub OAuth setup in Step 3.4 exists.)
- **Admin bulk import** from a CSV/JSON of known mappings:

  ```csv
  github_login,slack_email,slack_user_id
  octocat,octocat@example.com,
  hubot,,U01234567
  ```

  ```bash
  pnpm admin:import-identities -- ./identities.csv
  ```

  Each row needs a GitHub login plus either a Slack email or a Slack user ID.

Until a user is linked, invites/mentions degrade gracefully to their plain GitHub
login (no crash).

---

## 8. Optional features

### 8.1 `#shipped` announcement on merge

Post `<repo>#<number> <title> has shipped` to a shared channel when a PR merges.

```bash
SLACK_SHIPPED_CHANNEL=shipped     # channel name, or a channel ID like C0123ABCD
```

Unset = disabled. The bot auto-joins the channel on first post (needs the
`channels:join` scope from Step 4.1).

### 8.2 Comment the Slack channel URL back on the PR (opt-in GitHub write)

This is the **only** feature that writes to GitHub, and it's **off by default**.
When enabled, a merged PR gets one comment linking to its Slack channel.

To enable:

1. In the GitHub App settings, change **Pull requests** permission to
   **Read & write**, then **reinstall/reapprove** the app (a permission change
   requires re-approval). Without write access the comment POST returns `403`.
2. Set:

   ```bash
   GITHUB_COMMENT_ON_MERGE=true
   ```

Leave it `false` (or unset) to keep the app fully read-only and one-way.

---

## 9. Deploy

On any long-running Node host (a managed Node platform, a container, etc.):

1. Put every variable from Step 5 (plus any optional ones) into the platform's
   **secret store** — never commit real secrets. The service loads them from the
   environment and never logs them.
2. Point the deployed service at your real `PUBLIC_URL`, and make sure GitHub's
   webhook URL, GitHub's OAuth callback, and Slack's slash-command Request URL
   all use that same origin.
3. Run migrations against the production database before/with the first deploy:

   ```bash
   pnpm db:migrate
   ```

4. Run a **single instance** (the service assumes a single active writer). If you
   scale out later, the job/reminder claiming is already DB-backed, but keep to
   one instance unless you've confirmed the concurrency model.

The included `unkey.deploy.json` describes the entrypoint, health check, and the
secret names to provide.

---

## 10. Troubleshooting

Every Slack/GitHub API error is logged with actionable detail. Common ones:

| Log / symptom | Cause & fix |
| --- | --- |
| `Slack API error: missing_scope — needed scope: X` | Add scope `X` in Step 4.1 and **reinstall** the Slack app. |
| `not_in_channel` (repeated) | The bot isn't in a channel it's posting to. It self-heals by joining — ensure `channels:join` is granted and the app was reinstalled. |
| `installation_not_allowed` (webhook rejected) | The event's `installation.id` isn't `GITHUB_INSTALLATION_ID`. Set the right id (Step 3.6). |
| `invalid_signature` on the webhook | `GITHUB_WEBHOOK_SECRET` doesn't match the value in the GitHub App's webhook config. |
| `PR channel is not ready …` logged at **info**, then resolves | Normal: a child event (CI/comment) arrived before the PR channel existed; it retries and self-heals. |
| `mergeability not computed yet` (info, retries) | Normal: GitHub computes `mergeable_state` asynchronously; it settles on retry. |
| Merge comment fails with `403` | The App lacks write permission — do Step 8.2 (grant Pull requests: Read & write, reinstall). |
| `failed to set channel topic` (warn) | Topic is best-effort; if it names a missing scope, add it and reinstall. Channel creation is unaffected. |
| `/ready` returns not-ready | `DATABASE_URL` is wrong/unreachable, or migrations haven't run (`pnpm db:migrate`). |

---

## Environment variable reference

**Required**

| Variable | Where to get it | Notes |
| --- | --- | --- |
| `GITHUB_APP_ID` | GitHub App → General → App ID | numeric |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App → Private keys → Generate | full `.pem` contents |
| `GITHUB_WEBHOOK_SECRET` | you generate (`openssl rand -hex 32`) | also entered in the App's webhook config |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub App → General → Client ID | for `/link-github` |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub App → Client secrets → Generate | secret |
| `GITHUB_INSTALLATION_ID` | install URL trailing number | single numeric; allowlisted |
| `OAUTH_STATE_SECRET` | you generate (`openssl rand -hex 32`) | ≥ 32 chars |
| `PUBLIC_URL` | your host | HTTPS origin, no path |
| `SLACK_BOT_TOKEN` | Slack → OAuth & Permissions | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | Slack → Basic Information | secret |
| `SLACK_TEAM_ID` | `auth.test`, or workspace settings | `T…` |
| `DATABASE_URL` | Step 2 | Postgres connection URL |

**Optional (have sensible defaults)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | runtime mode |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SLACK_SHIPPED_CHANNEL` | unset (disabled) | `#shipped` announcement channel (id or name) |
| `GITHUB_COMMENT_ON_MERGE` | `false` | opt-in GitHub write (needs write permission) |
| `REMINDER_HOURS` | `12` | hours before a pending-review reminder becomes due |
| `REMINDER_SCAN_INTERVAL_MS` | `60000` | how often the reminder loop scans |
| `REMINDER_WINDOW_START_HOUR` | `5` | reminders only deliver at/after this hour (inclusive) |
| `REMINDER_WINDOW_END_HOUR` | `14` | reminders stop delivering at this hour (exclusive) |
| `REMINDER_WINDOW_TZ` | `America/New_York` | IANA time zone the window is evaluated in |

Secrets (never logged, load from the platform secret store in production):
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`,
`OAUTH_STATE_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL`.
