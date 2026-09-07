import { schedule } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { getDbClient } from "../../src/db/client";
import { ensureMigrated } from "../../src/db/migrate";
import {
  pruneExpiredSessions,
  pruneObsoleteQuotaBuckets,
  type PruningOptions,
} from "../../src/db/pruning";
import { logger } from "../../src/lib/logger";

/**
 * Authentication-data shard: expired sessions and obsolete quota buckets.
 * Daily at 05:41 UTC — disjoint from every other shard's schedule and rows.
 */
const WORK_BUDGET_MS = 20_000;

export async function runOnce(nowMs: number): Promise<void> {
  const config = getServerConfig();
  const db = getDbClient(config);
  await ensureMigrated(db, nowMs);

  const options: PruningOptions = {
    clock: { nowMs: () => Date.now() },
    deadlineMs: nowMs + WORK_BUDGET_MS,
  };

  const outcomes = await Promise.allSettled([
    pruneExpiredSessions(db, options),
    pruneObsoleteQuotaBuckets(db, options),
  ]);
  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      failed = true;
      logger.error("pruning_shard_failed", {
        shard: "auth-data",
        reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
  if (failed) throw new Error("auth-data pruning shard reported failures");
}

export default schedule("41 5 * * *", async () => {
  await runOnce(Date.now());
  return { statusCode: 204 as const };
});
