#!/usr/bin/env node
// One-shot migration CLI: `pnpm migrate` (or `node scripts/run-migrations.mjs`).
// Uses DATABASE_URL / DATABASE_AUTH_TOKEN from the environment or `.env`.
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";

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

await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`);

const applied = await client.execute("SELECT version FROM _migrations ORDER BY version");
const appliedVersions = new Set(applied.rows.map((row) => Number(row["version"])));

for (const migration of MIGRATIONS) {
  if (appliedVersions.has(migration.version)) {
    console.log(`[migrate] already applied: ${migration.version} ${migration.name}`);
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
    console.log(`[migrate] applied: ${migration.version} ${migration.name}`);
  } catch (error) {
    await tx.rollback();
    console.error(`[migrate] FAILED: ${migration.version} ${migration.name}`, error);
    process.exit(1);
  }
}

console.log("[migrate] up to date.");
