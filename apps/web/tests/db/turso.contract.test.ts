import { describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ensureMigrated } from "../../src/db/migrate";
import { createCacheRepository } from "../../src/db/repositories/cache-repository";

/**
 * Opt-in Turso contract tests. The repository contract must behave
 * identically against remote Turso as against local SQLite. Enable by
 * providing a disposable test database:
 *
 *   TURSO_CONTRACT_TEST_URL=libsql://your-test-db.turso.io \
 *   TURSO_CONTRACT_TEST_TOKEN=<token> pnpm vitest run tests/db/turso.contract.test.ts
 *
 * Without these variables the suite is skipped; local SQLite coverage in
 * repositories.contract.test.ts always runs.
 */
const url = process.env.TURSO_CONTRACT_TEST_URL;
const token = process.env.TURSO_CONTRACT_TEST_TOKEN;

describe.skipIf(!url)("Turso contract (opt-in)", () => {
  let client: Client | undefined;

  it("runs the same migrations and cache contract against Turso", async () => {
    client = createClient({ url: url as string, authToken: token || undefined });
    await ensureMigrated(client);

    const cache = createCacheRepository(client, { nowMs: () => Date.now() });
    const key = `contract-${Date.now()}`;
    await cache.write("wordnik", key, '"turso"', { freshForMs: 1_000, retainForMs: 1_000 });
    const read = await cache.read("wordnik", key);
    expect(read.status).toBe("fresh");
  });
});
