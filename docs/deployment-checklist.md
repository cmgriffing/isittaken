# Deployment Checklist — build-package-name-finder

Recorded from the full verification run (`pnpm verify`) on 2026-08-30.

| Check                                           | Command                                                    | Outcome                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lint                                            | `pnpm lint`                                                | PASS (0 errors)                                                                                       |
| Formatting                                      | `pnpm format:check`                                        | PASS                                                                                                  |
| Astro check                                     | `pnpm astro check`                                         | PASS (0 errors, 0 warnings)                                                                           |
| Type check                                      | `pnpm typecheck`                                           | PASS (strict TS, `noUncheckedIndexedAccess`)                                                          |
| Unit / adapter / API / contract / journey tests | `pnpm test`                                                | PASS — 118 passed, 1 skipped (opt-in Turso contract)                                                  |
| Browser tests (static build + hydration)        | `pnpm test:browser`                                        | PASS — 6/6                                                                                            |
| Local SQLite migrations                         | `pnpm migrate`                                             | PASS — version 1 `init-core-tables` applied, idempotent on re-run                                     |
| Scheduled-function one-shot invocation          | `pnpm vitest run tests/scheduled/local-invocation.test.ts` | PASS — all 4 shards, second pass idempotent                                                           |
| Production build shape                          | `node scripts/verify-production-build.mjs`                 | PASS — 5 static pages, hashed assets, **no SSR handler**, 10 standalone Functions, `/api/*` redirects |

## Pre-deploy actions (environment-specific)

1. **Database**: create Turso DB, set `DATABASE_URL` + `DATABASE_AUTH_TOKEN` with **builds** scope. Migrations apply during each deploy (`pnpm migrate && pnpm build` in `netlify.toml`); verify `[migrate]` lines in the build log — `applied` on the first deploy, `already applied` on later ones.
2. **GitHub OAuth App**: register per environment with callback `<site>/api/auth/github/callback`; set `GITHUB_CLIENT_ID`/`SECRET`.
3. **Wordnik**: set `WORDNIK_API_KEY` (optional — search degrades gracefully without it).
4. **OpenRouter**: set `OPENROUTER_API_KEY`, confirm `OPENROUTER_MODEL` supports structured output; start with a low `QUOTA_APP_DAILY_GENERATIONS`.
5. **Sessions**: leave `SESSION_COOKIE_SECURE` unset (production defaults it on); set `PUBLIC_SITE_URL` to the production origin.
6. **Pruning schedules**: deploy, invoke each shard once (manual invocation), then enable schedules.
7. **Rollback**: see docs/deployment.md — per-route redirects, provider kill-switches via env vars; to stop build-time migrations, revert `netlify.toml`'s command to `pnpm build`; migrations are additive-only, so no schema rollback is ever required.
