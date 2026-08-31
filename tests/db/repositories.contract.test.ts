import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureMigrated } from "../../src/db/migrate";
import { createCacheRepository } from "../../src/db/repositories/cache-repository";
import { LibsqlUserRepository } from "../../src/db/repositories/user-repository";
import { LibsqlSessionRepository } from "../../src/db/repositories/session-repository";
import { LibsqlQuotaRepository, periodStartFor } from "../../src/db/repositories/quota-repository";
import { decodeVersionedValue, encodeVersionedValue } from "../../src/domain/cache-value";
import type { IdGenerator } from "../../src/domain/ports";

let dbDir: string;
let client: Client;
let now = 1_000_000_000_000;
const clock = { nowMs: () => now };

const ids: IdGenerator = {
  newId: (() => {
    let n = 0;
    return () => `id-${(n += 1)}`;
  })(),
};

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "isittaken-contract-"));
  client = createClient({ url: `file:${join(dbDir, "test.db")}` });
  await ensureMigrated(client, clock.nowMs());
});

afterAll(() => {
  client?.close();
  if (dbDir) rmSync(dbDir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("create the required tables and indexes", async () => {
    for (const table of ["cache_entries", "users", "sessions", "ai_usage_buckets"]) {
      const result = await client.execute(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
      );
      expect(result.rows, table).toHaveLength(1);
    }
    const index = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_expires'",
    );
    expect(index.rows).toHaveLength(1);
  });

  it("is idempotent when re-run", async () => {
    const applied = await ensureMigrated(client, clock.nowMs());
    expect(applied).toEqual([]);
  });
});

describe("cache repository", () => {
  it("round-trips fresh, stale, expired, and missing entries", async () => {
    const cache = createCacheRepository(client, clock);

    await cache.write("wordnik", "k1", JSON.stringify({ a: 1 }), {
      freshForMs: 1_000,
      retainForMs: 2_000,
    });

    const fresh = await cache.read("wordnik", "k1");
    expect(fresh.status).toBe("fresh");
    if (fresh.status === "fresh") expect(JSON.parse(fresh.valueJson)).toEqual({ a: 1 });

    now += 1_500; // past freshness, before expiry
    const stale = await cache.read("wordnik", "k1");
    expect(stale.status).toBe("stale");
    if (stale.status === "stale") expect(stale.valueJson).toBeDefined();

    now += 10_000; // past expiry
    const expired = await cache.read("wordnik", "k1");
    expect(expired.status).toBe("expired");

    const missing = await cache.read("wordnik", "never-written");
    expect(missing.status).toBe("miss");
  });

  it("separates families with the same key", async () => {
    const cache = createCacheRepository(client, clock);
    await cache.write("registry-available", "shared", '"a"', { freshForMs: 100, retainForMs: 100 });
    const other = await cache.read("registry-taken", "shared");
    expect(other.status).toBe("miss");
  });

  it("upserts by family and key", async () => {
    const cache = createCacheRepository(client, clock);
    await cache.write("wordnik", "up", '"one"', { freshForMs: 1_000, retainForMs: 1_000 });
    await cache.write("wordnik", "up", '"two"', { freshForMs: 1_000, retainForMs: 1_000 });
    const read = await cache.read("wordnik", "up");
    expect(read.status).toBe("fresh");
    if (read.status === "fresh") expect(JSON.parse(read.valueJson)).toBe("two");
  });
});

describe("versioned cache values", () => {
  it("decodes matching versions and rejects everything else", () => {
    const json = encodeVersionedValue(2, { words: ["laser"] });
    expect(decodeVersionedValue<{ words: string[] }>(json, 2)).toEqual({ words: ["laser"] });
    expect(decodeVersionedValue(json, 1)).toBeNull();
    expect(decodeVersionedValue("not json", 2)).toBeNull();
    expect(decodeVersionedValue(JSON.stringify({ nope: true }), 2)).toBeNull();
  });
});

describe("user repository", () => {
  it("upserts by immutable GitHub ID and refreshes display snapshots", async () => {
    const users = new LibsqlUserRepository(client, ids);
    const first = await users.upsertByGithubId(
      { githubId: "gh-1", githubLogin: "octo", avatarUrl: "http://a/1.png" },
      clock.nowMs(),
    );
    now += 5_000;
    const second = await users.upsertByGithubId(
      { githubId: "gh-1", githubLogin: "octo-renamed", avatarUrl: null },
      clock.nowMs(),
    );

    expect(second.id).toBe(first.id);
    expect(second.githubLogin).toBe("octo-renamed");
    expect(second.avatarUrl).toBeNull();
    expect(second.updatedAtMs).toBeGreaterThan(first.createdAtMs);

    const all = await client.execute("SELECT id FROM users");
    expect(all.rows).toHaveLength(1);
  });
});

describe("session repository", () => {
  it("enforces expiry, refresh metadata, and revocation", async () => {
    const sessions = new LibsqlSessionRepository(client);
    const users = new LibsqlUserRepository(client, ids);
    const user = await users.upsertByGithubId(
      { githubId: "gh-2", githubLogin: "sessioner", avatarUrl: null },
      clock.nowMs(),
    );

    const record = {
      tokenHash: "hash-abc",
      userId: user.id,
      createdAtMs: clock.nowMs(),
      expiresAtMs: clock.nowMs() + 60_000,
      lastSeenAtMs: clock.nowMs(),
    };
    await sessions.create(record);

    const valid = await sessions.findValid("hash-abc", clock.nowMs());
    expect(valid?.userId).toBe(user.id);

    now += 30_000;
    await sessions.touch("hash-abc", clock.nowMs());
    const touched = await sessions.findValid("hash-abc", clock.nowMs());
    expect(touched?.lastSeenAtMs).toBe(clock.nowMs());

    now += 120_000;
    const expired = await sessions.findValid("hash-abc", clock.nowMs());
    expect(expired).toBeNull();

    await sessions.create({ ...record, tokenHash: "hash-xyz" });
    await sessions.revoke("hash-xyz");
    expect(await sessions.findValid("hash-xyz", clock.nowMs())).toBeNull();
  });
});

describe("quota repository", () => {
  it("reserves atomically up to the limit under concurrency", async () => {
    const quotas = new LibsqlQuotaRepository(client);
    const subject = { subjectType: "user" as const, subjectId: "u-quota" };
    const period = periodStartFor(clock.nowMs(), "periodic-day");
    const limit = 5;

    const results = await Promise.all(
      Array.from({ length: 12 }, () => quotas.reserve(subject, "periodic-day", period, limit, 1)),
    );

    const granted = results.filter((r) => r.granted);
    expect(granted).toHaveLength(limit);
    for (const result of results.filter((r) => !r.granted)) {
      expect(result.usedAfter).toBe(limit);
      expect(result.resetsAtMs).toBeGreaterThan(clock.nowMs());
    }
  });

  it("refunds and settles usage metadata", async () => {
    const quotas = new LibsqlQuotaRepository(client);
    const subject = { subjectType: "user" as const, subjectId: "u-settle" };
    const period = periodStartFor(clock.nowMs(), "burst-minute");

    const first = await quotas.reserve(subject, "burst-minute", period, 2, 1);
    expect(first.granted).toBe(true);
    const second = await quotas.reserve(subject, "burst-minute", period, 2, 1);
    expect(second.granted).toBe(true);
    const third = await quotas.reserve(subject, "burst-minute", period, 2, 1);
    expect(third.granted).toBe(false);

    await quotas.refund(subject, "burst-minute", period, 1);
    const afterRefund = await quotas.reserve(subject, "burst-minute", period, 2, 1);
    expect(afterRefund.granted).toBe(true);

    await quotas.settle(subject, "burst-minute", period, {
      promptTokens: 120,
      completionTokens: 45,
      estimatedCostMicroUSD: 300,
    });
    const usage = await quotas.read(subject, "burst-minute", period);
    expect(usage.used).toBe(2);
    const buckets = await client.execute({
      sql: "SELECT prompt_tokens, completion_tokens, estimated_cost_microusd FROM ai_usage_buckets WHERE subject_id = 'u-settle'",
      args: [],
    });
    expect(Number(buckets.rows[0]?.["prompt_tokens"])).toBe(120);
    expect(Number(buckets.rows[0]?.["estimated_cost_microusd"])).toBe(300);
  });

  it("floors period starts to UTC windows", () => {
    const ts = Date.UTC(2026, 7, 29, 10, 30, 15, 123);
    expect(periodStartFor(ts, "burst-minute")).toBe(ts - (ts % 60_000));
    expect(periodStartFor(ts, "periodic-day")).toBe(Date.UTC(2026, 7, 29));
  });
});
