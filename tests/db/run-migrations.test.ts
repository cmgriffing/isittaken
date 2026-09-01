import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { runMigrations } from "../../scripts/run-migrations.mjs";
import { MIGRATIONS } from "../../src/db/migrations.mjs";

type Command = { sql: string; args?: unknown[] };

/**
 * Fake @libsql/client client that simulates the bookkeeping PRIMARY KEY
 * conflict deterministically: when `winnerApplies` is true, the concurrent
 * runner's bookkeeping row lands before ours, so our INSERT hits the
 * conflict but the re-read finds the version recorded.
 */
function raceClient(options: { winnerApplies: boolean }) {
  const messages: string[] = [];
  const bookkeeping: Array<{ version: number }> = [];

  const client = {
    async execute(command: Command | string) {
      const sql = typeof command === "string" ? command : command.sql;
      if (sql.startsWith("SELECT version FROM _migrations ORDER BY version")) {
        return { rows: bookkeeping.map((row) => ({ version: row.version })) };
      }
      if (sql.startsWith("SELECT version FROM _migrations WHERE version =")) {
        const version = Number((command as Command).args?.[0]);
        const present = bookkeeping.some((row) => row.version === version);
        return { rows: present ? [{ version }] : [] };
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    async executeMultiple() {},
    async transaction() {
      return {
        async executeMultiple() {},
        async execute(command: Command) {
          if (!command.sql.startsWith("INSERT INTO _migrations")) {
            throw new Error(`unexpected tx execute: ${command.sql}`);
          }
          const version = Number(command.args?.[0]);
          if (options.winnerApplies) bookkeeping.push({ version });
          throw new Error("UNIQUE constraint failed: _migrations.version");
        },
        async commit() {},
        async rollback() {},
      };
    },
  };

  return {
    client,
    messages,
    logs: {
      log: (...parts: unknown[]) => messages.push(parts.map(String).join(" ")),
      error: (...parts: unknown[]) => messages.push(parts.map(String).join(" ")),
    },
  };
}

describe("runMigrations race semantics", () => {
  // The fake implements the subset of @libsql/client's Client that
  // runMigrations uses; tests drive it through that same subset.
  const asClient = (partial: object) => partial as unknown as Client;

  it("continues successfully when the conflict means another runner applied the version", async () => {
    const harness = raceClient({ winnerApplies: true });

    await expect(
      runMigrations({
        client: asClient(harness.client),
        migrations: MIGRATIONS,
        log: harness.logs,
      }),
    ).resolves.toBeUndefined();

    expect(harness.messages).toContainEqual(
      expect.stringContaining("lost the race: already applied 1 init-core-tables"),
    );
    expect(harness.messages).toContainEqual("[migrate] up to date.");
  });

  it("fails when the version is still absent after the re-check", async () => {
    const harness = raceClient({ winnerApplies: false });

    await expect(
      runMigrations({
        client: asClient(harness.client),
        migrations: MIGRATIONS,
        log: harness.logs,
      }),
    ).rejects.toThrow(/FAILED: 1 init-core-tables/);

    expect(harness.messages).not.toContainEqual(expect.stringContaining("lost the race"));
  });
});

describe("migration CLI", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const dir of directories.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "migrations-race-"));
    directories.push(dir);
    return dir;
  }

  function runCli(dir: string, databaseFile: string) {
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/run-migrations.mjs", import.meta.url))],
      {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: `file:${databaseFile}` },
        encoding: "utf8",
      },
    );
  }

  it("applies migrations on a fresh database and exits zero idempotently on re-run", async () => {
    const dir = await makeTempDir();
    const database = join(dir, "fresh.db");

    const first = runCli(dir, database);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("[migrate] applied: 1 init-core-tables");

    const second = runCli(dir, database);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("already applied: 1 init-core-tables");
    expect(second.stdout).toContain("[migrate] up to date.");
  });

  it("exits non-zero when the bookkeeping insert fails with the version still unrecorded", async () => {
    const dir = await makeTempDir();
    const database = join(dir, "boobytrapped.db");
    // The CHECK constraint makes every bookkeeping INSERT fail while SELECTs
    // keep working: a transaction failure whose version is genuinely absent.
    const client = await import("@libsql/client").then(({ createClient }) =>
      createClient({ url: `file:${database}` }),
    );
    await client.executeMultiple(`
CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  CHECK (0)
);
`);
    client.close();

    const result = runCli(dir, database);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("FAILED: 1 init-core-tables");
  });
});
