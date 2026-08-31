#!/usr/bin/env node
// One-shot migration CLI: `pnpm migrate` (or `node scripts/run-migrations.mjs`).
// Uses DATABASE_URL / DATABASE_AUTH_TOKEN from the environment or `.env`.
// runMigrations() is exported so tests can drive identical logic against any
// @libsql/client-compatible client.
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} RunMigrationsParams
 * @property {import("@libsql/client").Client} client A libsql/client-compatible client instance.
 * @property {Array<{ version: number, name: string, sql: string }>} migrations Ordered migrations to apply.
 * @property {{ log: (...parts: unknown[]) => void, error: (...parts: unknown[]) => void }} [log]
 *   Console-like sink; defaults to the global console.
 */

/**
 * Applies pending migrations in order. Each migration runs inside a write
 * transaction together with its `_migrations` bookkeeping row.
 *
 * Race tolerance: when a transaction fails because a concurrent runner (an
 * overlapping Netlify build, or a cold-starting function's self-heal) applied
 * the same version in the overlap window, the runner re-reads `_migrations`
 * once; if the version is now present it logs "lost the race" and continues,
 * otherwise the failure is genuine and it throws. Safe only because
 * migrations are pure additive DDL (see src/db/migrations.mjs contract).
 *
 * @param {RunMigrationsParams} params
 */
export async function runMigrations({ client, migrations, log = console }) {
  await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`);

  const applied = await client.execute("SELECT version FROM _migrations ORDER BY version");
  const appliedVersions = new Set(applied.rows.map((row) => Number(row["version"])));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      log.log(`[migrate] already applied: ${migration.version} ${migration.name}`);
      continue;
    }
    const tx = await client.transaction("write");
    try {
      await tx.executeMultiple(migration.sql);
      await tx.execute({
        sql: "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
        args: [migration.version, migration.name, Date.now()],
      });
      await tx.commit();
      log.log(`[migrate] applied: ${migration.version} ${migration.name}`);
    } catch (error) {
      await tx.rollback();
      const recheck = await client.execute({
        sql: "SELECT version FROM _migrations WHERE version = ?",
        args: [migration.version],
      });
      if (recheck.rows.length > 0) {
        log.log(`[migrate] lost the race: already applied ${migration.version} ${migration.name}`);
        continue;
      }
      log.error(`[migrate] FAILED: ${migration.version} ${migration.name}`, error);
      throw new Error(
        `[migrate] FAILED: ${migration.version} ${migration.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  log.log("[migrate] up to date.");
}

function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main() {
  loadDotEnv();

  const url = process.env.DATABASE_URL ?? "file:./local.db";
  console.log(
    `[migrate] database: ${url.startsWith("file:") ? url : url.replace(/:[^@/]+@/, ":***@")}`,
  );

  const client = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });

  // Import migrations from the shared module (plain .mjs, no build step needed).
  const { MIGRATIONS } = await import("../src/db/migrations.mjs");

  try {
    await runMigrations({ client, migrations: MIGRATIONS });
  } catch {
    process.exit(1);
  }
}

// Only run the CLI when executed directly (tests import runMigrations instead).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
