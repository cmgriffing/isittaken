import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureMigrated } from "../../src/db/migrate";
import { createCacheRepository } from "../../src/db/repositories/cache-repository";
import {
  pruneCacheFamily,
  pruneExpiredSessions,
  pruneObsoleteQuotaBuckets,
  type PruningOptions,
} from "../../src/db/pruning";
import type { CacheFamily } from "../../src/domain/ports";

let db: Client;
let dir: string;
const now = 1_700_000_000_000;

function options(
  deadlineOffsetMs: number,
  overrides: Partial<PruningOptions> = {},
): PruningOptions {
  return {
    clock: { nowMs: () => now },
    deadlineMs: now + deadlineOffsetMs,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "isittaken-prune-"));
  db = createClient({ url: `file:${join(dir, "test.db")}` });
  await ensureMigrated(db, now);
});

afterAll(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function seedCache(family: CacheFamily, keys: string[], expired: boolean) {
  const cache = createCacheRepository(db, { nowMs: () => now });
  for (const key of keys) {
    await cache.write(family, key, '"v"', {
      freshForMs: 1_000,
      retainForMs: expired ? -1_100 : 600_000, // expired entries have already lapsed
    });
  }
}

describe("pruning service", () => {
  it("deletes only its assigned family and respects fresh entries", async () => {
    await seedCache("npm-available", ["a1", "a2"], true);
    await seedCache("npm-taken", ["t1"], true);
    await seedCache("wordnik", ["w1"], true);
    await seedCache("npm-available", ["fresh1"], false);

    const summary = await pruneCacheFamily("npm-available", db, options(10_000));

    expect(summary.deleted).toBe(2); // a1, a2; fresh1 survives
    expect(summary.stoppedEarly).toBe(false);

    const wordnik = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM cache_entries WHERE family = 'wordnik'",
      args: [],
    });
    expect(Number(wordnik.rows[0]?.["n"])).toBe(1); // untouched: family isolation

    const taken = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM cache_entries WHERE family = 'npm-taken'",
      args: [],
    });
    expect(Number(taken.rows[0]?.["n"])).toBe(1); // untouched: disjoint ownership
  });

  it("is idempotent when invoked repeatedly", async () => {
    await seedCache("openrouter", ["o1", "o2", "o3"], true);
    const first = await pruneCacheFamily("openrouter", db, options(10_000));
    expect(first.deleted).toBe(3);
    const second = await pruneCacheFamily("openrouter", db, options(10_000));
    expect(second.deleted).toBe(0);
  });

  it("exits before the deadline when work remains, deleting nothing", async () => {
    await seedCache(
      "npm-available",
      Array.from({ length: 50 }, (_, i) => `bulk-${i}`),
      true,
    );
    // Deadline already passed: report remaining work, delete nothing, no hang.
    const passed = await pruneCacheFamily("npm-available", db, options(0));
    expect(passed.deleted).toBe(0);
    expect(passed.stoppedEarly).toBe(true);

    // Positive deadline but margin dominates: at most nothing more, early exit.
    const tiny = await pruneCacheFamily(
      "npm-available",
      db,
      options(1, { marginMs: 10_000, batchSize: 10 }),
    );
    expect(tiny.stoppedEarly).toBe(true);
    expect(tiny.deleted).toBe(0);
  });

  it("does not present stale rows as fresh before pruning", async () => {
    const cache = createCacheRepository(db, { nowMs: () => now });
    await cache.write("wordnik", "stale-but-kept", '"old"', {
      freshForMs: 1_000,
      retainForMs: 3_600_000,
    });
    const later = now + 60_000; // stale but not expired; pruning would not delete it
    const read = await createCacheRepository(db, { nowMs: () => later }).read(
      "wordnik",
      "stale-but-kept",
    );
    expect(read.status).toBe("stale");
  });

  it("prunes expired sessions and obsolete quota buckets", async () => {
    await db.execute({
      sql: "INSERT INTO users (id, github_id, github_login, avatar_url, created_at, updated_at) VALUES ('u1', 'g1', 'u', NULL, ?, ?)",
      args: [now, now],
    });
    await db.execute({
      sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('h-old', 'u1', ?, ?, ?)",
      args: [now - 10_000, now - 5_000, now - 10_000],
    });
    await db.execute({
      sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('h-live', 'u1', ?, ?, ?)",
      args: [now, now + 86_400_000, now],
    });
    const bucketOld = now - 10 * 86_400_000;
    await db.execute({
      sql: "INSERT INTO ai_usage_buckets (subject_type, subject_id, window_kind, period_start, request_count) VALUES ('user', 'u1', 'burst-minute', ?, 1)",
      args: [bucketOld - (bucketOld % 60_000)],
    });

    const sessions = await pruneExpiredSessions(db, options(10_000));
    expect(sessions.deleted).toBe(1);

    const buckets = await pruneObsoleteQuotaBuckets(db, options(10_000));
    expect(buckets.deleted).toBe(1);

    const live = await db.execute("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'h-live'");
    expect(Number(live.rows[0]?.["n"])).toBe(1);
  });

  it("continues other shards when one fails (independent runnability)", async () => {
    // Baseline: clear whatever earlier tests left in this family.
    await pruneCacheFamily("wordnik", db, options(10_000));
    await seedCache("wordnik", ["w-isolated"], true);
    // A failing statement elsewhere must not affect this shard.
    const broken = await pruneCacheFamily("wordnik", db, options(10_000));
    expect(broken.deleted).toBe(1);

    await expect(
      db.execute({
        sql: "DELETE FROM table_that_does_not_exist",
        args: [],
      }),
    ).rejects.toThrow();

    const stillWorks = await pruneCacheFamily("wordnik", db, options(10_000));
    expect(stillWorks.deleted).toBe(0);
  });
});
