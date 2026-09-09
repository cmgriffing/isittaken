import { schedule } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { getDbClient } from "../../src/db/client";
import { ensureMigrated } from "../../src/db/migrate";
import { pruneCacheFamily, type PruningOptions } from "../../src/db/pruning";
import { logger } from "../../src/lib/logger";

/**
 * Availability shard: registry-available + registry-taken cache families
 * (all server-venue registries share these two generic families).
 * Runs hourly, matching the shortest TTLs. Netlify scheduled functions are
 * limited to 30s; the work deadline keeps margin so we always return in time.
 */
const WORK_BUDGET_MS = 20_000;

/** One invocation of the shard; also used for local one-shot invocation. */
export async function runOnce(nowMs: number): Promise<void> {
  const config = getServerConfig();
  const db = getDbClient(config);
  await ensureMigrated(db, nowMs);

  const options: PruningOptions = {
    clock: { nowMs: () => Date.now() },
    deadlineMs: nowMs + WORK_BUDGET_MS,
  };

  const summaries = await Promise.allSettled([
    pruneCacheFamily("registry-available", db, options),
    pruneCacheFamily("registry-taken", db, options),
  ]);
  for (const outcome of summaries) {
    if (outcome.status === "rejected") {
      logger.error("pruning_shard_failed", {
        shard: "availability",
        reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
}

export default schedule("@hourly", async () => {
  await runOnce(Date.now());
  return { statusCode: 204 as const };
});
