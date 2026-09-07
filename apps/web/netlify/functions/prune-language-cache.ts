import { schedule } from "@netlify/functions";
import { getServerConfig } from "../../src/config/server";
import { getDbClient } from "../../src/db/client";
import { ensureMigrated } from "../../src/db/migrate";
import { pruneCacheFamily, type PruningOptions } from "../../src/db/pruning";
import { logger } from "../../src/lib/logger";

/**
 * Language shard: the Wordnik cache family. Daily at 03:17 UTC — staggered
 * away from the other daily shards to reduce database write contention.
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

  try {
    await pruneCacheFamily("wordnik", db, options);
  } catch (error) {
    logger.error("pruning_shard_failed", {
      shard: "language",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export default schedule("17 3 * * *", async () => {
  await runOnce(Date.now());
  return { statusCode: 204 as const };
});
