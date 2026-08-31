# Deployment and Operations Guide

## Environment variables

Copy `.env.example` to `.env` for local development. In Netlify, configure
the same variables under **Site settings → Environment variables**.

| Variable                                            | Required       | Notes                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                      | yes            | `file:./local.db` locally; `libsql://…turso.io` in production. Production refuses `file:` URLs unless `ALLOW_LOCAL_DB_IN_PRODUCTION=true` (previews only). Must be scoped to **builds** as well as functions: every deploy runs migrations during the build. |
| `DATABASE_AUTH_TOKEN`                               | Turso only     | Turso auth token; omit for local SQLite. Must be scoped to **builds** as well as functions.                                                                                                                                                                  |
| `WORDNIK_API_KEY`                                   | for enrichment | Without it, Wordnik reports as `skipped` and search still works.                                                                                                                                                                                             |
| `NPM_REGISTRY_ORIGIN`                               | no             | Defaults to `https://registry.npmjs.org`. Clients cannot override it.                                                                                                                                                                                        |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`         | for login      | Register one OAuth App per environment (below).                                                                                                                                                                                                              |
| `OPENROUTER_API_KEY`                                | for creativity | Without it, creative generation fails closed; ordinary search is unaffected.                                                                                                                                                                                 |
| `OPENROUTER_MODEL`                                  | no             | Must support structured output (JSON Schema response format). Default `openai/gpt-4o-mini`.                                                                                                                                                                  |
| `SESSION_COOKIE_SECURE`                             | no             | Defaults to `true` in production; set `false` only for `http://localhost`.                                                                                                                                                                                   |
| `PUBLIC_SITE_URL`                                   | yes in prod    | Used for same-origin enforcement on cookie-authenticated POSTs.                                                                                                                                                                                              |
| `CACHE_TTL_*`, `QUOTA_*`, `RATE_LIMIT_*`, `LIMIT_*` | no             | Safe defaults are documented in `.env.example`; adjustable without schema changes.                                                                                                                                                                           |
| `LOG_LEVEL`                                         | no             | `debug` \| `info` \| `warn` \| `error` (default `info`).                                                                                                                                                                                                     |

## Local SQLite setup and migrations

```bash
pnpm install
cp .env.example .env          # DATABASE_URL=file:./local.db by default
pnpm migrate                  # applies versioned migrations idempotently
pnpm dev                      # astro dev with Netlify env emulation
```

Migrations live in `src/db/migrations.mjs` (shared by the app and the CLI)
and are tracked in the `_migrations` table. `node scripts/run-migrations.mjs`
is what `pnpm migrate` runs; it reads `.env` itself.

## Schema migrations on deploy

The Netlify build command is `pnpm migrate && pnpm build` (see
`netlify.toml`), so the deploy itself is the migration gate:

- **Per-context databases by configuration**: the runner migrates whatever
  `DATABASE_URL` / `DATABASE_AUTH_TOKEN` its environment provides — there is
  no deploy-context logic in code. Pointing a different deploy context at a
  different database is purely a Netlify env-var change.
- **Env vars must be build-visible**: `DATABASE_URL` /
  `DATABASE_AUTH_TOKEN` need **builds** scope in Netlify. A function-only
  scope makes the build's migration step fail and blocks the deploy.
- **A migration failure fails the deploy**: pending migrations apply before
  the site builds; on failure the build aborts and the previous deploy keeps
  serving. Check the build log for `[migrate]` lines (`applied`,
  `already applied`, `lost the race`).
- **Additive-only contract**: migrations are pure additive, idempotent DDL
  (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`). Destructive
  changes follow the expand/contract two-deploy rule: deploy N adds the new
  shape (and backfills idempotently); deploy N+1 — after no deployed code
  reads the old shape — removes it. Never drop or rename in the same deploy
  that ships code using the new shape. The contract is documented in the
  `src/db/migrations.mjs` header comment.
- **Separate preview/branch DB (future)**: creating one is a configuration
  change only — scope a different `DATABASE_URL` (plus token) to the
  `deploy-preview` or branch-deploy context and that context's builds will
  migrate that database.

## GitHub OAuth registration

1. Create a **separate OAuth App per environment** (local and production):
   https://github.com/settings/developers
2. Set the **Authorization callback URL**:
   - local: `http://localhost:4321/api/auth/github/callback`
   - production: `https://<your-site>.netlify.app/api/auth/github/callback`
3. Put the Client ID / Client Secret into the matching environment's vars.

The app requests **no scopes**. The access token is used once, in memory, to
read the numeric user ID + login + avatar, and is never persisted.

## Turso deployment

```bash
turso db create isittaken
turso db show isittaken --url        # → DATABASE_URL (libsql://…)
turso db tokens create isittaken     # → DATABASE_AUTH_TOKEN
```

Set both in Netlify with **builds** scope (see "Schema migrations on
deploy" above): every deploy applies pending migrations to the database its
context points at before building the site, so a new database is provisioned
by deploying — no manual step. The manual CLI remains available for ops (e.g.
migrating a database without a deploy):

```bash
DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… pnpm migrate
```

The same repository code path serves both databases via `@libsql/client`.

## OpenRouter safeguards

- **Structured output**: the adapter requests strict JSON Schema output and
  rejects malformed model responses (no unvalidated text becomes a candidate).
- **Quotas before spend**: cache-miss generations atomically reserve the
  per-user burst limit, per-user daily quota, and the application-wide daily
  ceiling _before_ the model call. Concurrent requests cannot oversubscribe.
- **Refunds on selected failures**: transport/HTTP failures refund the
  longer-period quotas (the burst attempt stays counted).
- **Regeneration is explicit**: cache hits are free; "Regenerate" bypasses
  the cache and consumes quota.
- Start with a **low application ceiling** (`QUOTA_APP_DAILY_GENERATIONS`)
  and monitor `ai_usage_buckets` reconciliation.

## Pruning schedules

Four independent scheduled Functions own disjoint rows (see
[docs/scheduled-functions.md](./scheduled-functions.md)):

| Function                   | Schedule (UTC) |
| -------------------------- | -------------- |
| `prune-availability-cache` | hourly         |
| `prune-language-cache`     | daily 03:17    |
| `prune-ai-cache`           | daily 04:23    |
| `prune-auth-data`          | daily 05:41    |

Enable each schedule only after a successful local one-shot invocation
(`pnpm vitest run tests/scheduled/local-invocation.test.ts`). Pruning is
storage hygiene: cache reads always enforce freshness themselves, so delayed
or skipped pruning never serves stale values as fresh.

## Rollback controls

- **Static site**: redeploy any previous deploy from the Netlify UI — the
  site is fully static and remains servable even with all API routes broken.
- **API routes**: each Function declares its friendly `/api/*` route via its
  `config.path` export (Netlify Functions v2); removing a function file (or
  deploying with it removed) disables that surface independently. Unmatched
  `/api/*` paths are answered with a 404 by the catch-all redirect.
- **Providers**: unset `WORDNIK_API_KEY` (search continues without
  enrichment), unset `OPENROUTER_API_KEY` (creativity fails closed; search
  unaffected), or rotate GitHub credentials to block new logins.
- **Database**: migrations are additive; older deploys ignore new tables.
  Never destructively migrate during incident response — add and backfill
  (expand/contract, see "Schema migrations on deploy"). To stop applying
  migrations on deploy, revert `netlify.toml`'s build command to
  `pnpm build`; because migrations are additive, no schema rollback is ever
  required.
- **Sessions**: to force global logout, rotate the session cookie name
  (`SESSION_COOKIE_NAME`) — old cookies stop matching instantly.
