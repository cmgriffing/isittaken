import type { Client } from "@libsql/client";
import type { Clock } from "../domain/ports";
import { logger } from "../lib/logger";

/**
 * Sharded, deadline-aware pruning. Each shard owns disjoint rows, deletes
 * deterministic small batches indexed by its family, and stops with margin
 * before Netlify's execution limit. Pruning affects storage only — cache
 * reads enforce freshness independently on every request.
 */

export interface PruningOptions {
  clock: Clock;
  /** Absolute epoch deadline; the service stops before exceeding it. */
  deadlineMs: number;
  /** Safety margin reserved before the deadline (defaults 2s). */
  marginMs?: number;
  batchSize?: number;
}

export interface PruningSummary {
  shard: string;
  batches: number;
  deleted: number;
  stoppedEarly: boolean;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MARGIN_MS = 2_000;

async function deleteExpiredBatches(
  shard: string,
  db: Client,
  selectSql: string,
  deleteSql: string,
  selectArgs: (string | number)[],
  options: PruningOptions,
): Promise<PruningSummary> {
  const { clock, deadlineMs } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const marginMs = options.marginMs ?? DEFAULT_MARGIN_MS;
  const startedAt = clock.nowMs();

  let batches = 0;
  let deleted = 0;
  let stoppedEarly = false;

  while (true) {
    // Peek at the next deterministic batch.
    const selected = await db.execute({ sql: selectSql, args: [...selectArgs, batchSize] });
    const keys = selected.rows.map((row) => String(Object.values(row)[0]));
    if (keys.length === 0) break; // shard exhausted

    // Work remains but the deadline (with margin) would be exceeded.
    if (clock.nowMs() + marginMs >= deadlineMs) {
      stoppedEarly = true;
      break;
    }

    const placeholders = keys.map(() => "?").join(",");
    const result = await db.execute({
      sql: deleteSql.replace("{keys}", placeholders),
      args: [...selectArgs, ...keys],
    });
    deleted += result.rowsAffected;
    batches += 1;

    if (keys.length < batchSize) break; // exhausted this shard's work
  }

  const summary: PruningSummary = {
    shard,
    batches,
    deleted,
    stoppedEarly,
    durationMs: clock.nowMs() - startedAt,
  };
  logger.info("pruning_shard_completed", { ...summary });
  return summary;
}

/**
 * Prune expired cache entries for one family. Idempotent: repeated
 * invocations delete nothing once the family is clean, and a shard that
 * hits its deadline simply resumes on the next invocation.
 */
export function pruneCacheFamily(
  family: string,
  db: Client,
  options: PruningOptions,
): Promise<PruningSummary> {
  const nowMs = options.clock.nowMs();
  return deleteExpiredBatches(
    `cache:${family}`,
    db,
    `SELECT cache_key FROM cache_entries
     WHERE family = ? AND expires_at <= ?
     ORDER BY cache_key LIMIT ?`,
    `DELETE FROM cache_entries WHERE family = ? AND expires_at <= ? AND cache_key IN ({keys})`,
    [family, nowMs],
    options,
  );
}

/** Prune expired application sessions (indexed by expires_at). */
export function pruneExpiredSessions(db: Client, options: PruningOptions): Promise<PruningSummary> {
  const nowMs = options.clock.nowMs();
  return deleteExpiredBatches(
    "sessions:expired",
    db,
    `SELECT token_hash FROM sessions
     WHERE expires_at <= ?
     ORDER BY token_hash LIMIT ?`,
    `DELETE FROM sessions WHERE expires_at <= ? AND token_hash IN ({keys})`,
    [nowMs],
    options,
  );
}

/**
 * Prune obsolete quota buckets: burst-minute buckets older than two days and
 * periodic-day buckets older than 90 days. Recent history is kept for usage
 * reconciliation.
 */
export async function pruneObsoleteQuotaBuckets(
  db: Client,
  options: PruningOptions,
): Promise<PruningSummary> {
  const nowMs = options.clock.nowMs();
  const burstCutoff = nowMs - 2 * 86_400_000;
  const dayCutoff = nowMs - 90 * 86_400_000;

  const burst = await deleteExpiredBatches(
    "ai-usage:stale-burst",
    db,
    `SELECT period_start FROM ai_usage_buckets
     WHERE window_kind = 'burst-minute' AND period_start <= ?
     GROUP BY period_start ORDER BY period_start LIMIT ?`,
    `DELETE FROM ai_usage_buckets WHERE window_kind = 'burst-minute' AND period_start <= ? AND period_start IN ({keys})`,
    [burstCutoff],
    options,
  );
  const day = await deleteExpiredBatches(
    "ai-usage:stale-periodic",
    db,
    `SELECT period_start FROM ai_usage_buckets
     WHERE window_kind = 'periodic-day' AND period_start <= ?
     GROUP BY period_start ORDER BY period_start LIMIT ?`,
    `DELETE FROM ai_usage_buckets WHERE window_kind = 'periodic-day' AND period_start <= ? AND period_start IN ({keys})`,
    [dayCutoff],
    options,
  );

  return {
    shard: "ai-usage:obsolete-buckets",
    batches: burst.batches + day.batches,
    deleted: burst.deleted + day.deleted,
    stoppedEarly: burst.stoppedEarly || day.stoppedEarly,
    durationMs: burst.durationMs + day.durationMs,
  };
}
