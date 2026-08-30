# Scheduled Functions (Pruning Shards)

Four scheduled Netlify Functions own disjoint maintenance work. Every shard
is idempotent, runs in bounded deterministic batches, and stops before
Netlify's 30-second execution limit (20s work budget + safety margin).

| Function                   | Schedule (UTC)             | Owns                                                  |
| -------------------------- | -------------------------- | ----------------------------------------------------- |
| `prune-availability-cache` | `@hourly`                  | `cache_entries` families `npm-available`, `npm-taken` |
| `prune-language-cache`     | daily 03:17 (`17 3 * * *`) | `cache_entries` family `wordnik`                      |
| `prune-ai-cache`           | daily 04:23 (`23 4 * * *`) | `cache_entries` family `openrouter`                   |
| `prune-auth-data`          | daily 05:41 (`41 5 * * *`) | expired `sessions`, obsolete `ai_usage_buckets`       |

Pruning is storage hygiene only: cache reads always enforce `fresh_until`
against the request clock, so delayed or skipped pruning never causes a
stale value to be served as fresh.

## Enabling the schedules

Each shard's schedule activates on deploy. To ship the pruning behavior
before allowing its schedule to run in production, deploy with the schedule
disabled (remove/comment the `schedule(...)` registration per shard), verify
manually with the one-shot flow below, then re-enable one shard at a time.

## Local one-shot invocation

The shards run against whatever `DATABASE_URL` the environment provides; with
no configuration they use the local SQLite file `file:./local.db`.

```bash
# 1. Local SQLite migrations
pnpm migrate

# 2. Invoke every shard once (also verifies idempotency on the second pass)
pnpm vitest run tests/scheduled/local-invocation.test.ts
```

Each exported `runOnce(nowMs)` performs exactly one bounded pruning pass and
logs a JSON summary (`pruning_shard_completed`) with batches, deleted rows,
and whether the shard stopped early.

## Verification checklist (per shard)

- [ ] One-shot invocation succeeds against local SQLite.
- [ ] A second invocation deletes nothing (idempotent).
- [ ] Rows owned by _other_ families/tables are untouched (disjoint ownership).
- [ ] With an already-passed deadline the shard exits immediately with zero deletions.
