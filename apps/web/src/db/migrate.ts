import type { Client } from "@libsql/client";
import { MIGRATIONS } from "./migrations.mjs";

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

/**
 * Idempotent, ordered, versioned migrations. Each pending migration runs
 * inside a write transaction together with its bookkeeping row, so a failed
 * application leaves no partially applied schema. Safe to call on every
 * cold start and from the migration CLI.
 */
export async function ensureMigrated(client: Client, nowMs = Date.now()): Promise<number[]> {
  await client.executeMultiple(BOOTSTRAP_SQL);

  const applied = await client.execute("SELECT version FROM _migrations ORDER BY version");
  const appliedVersions = new Set<number>(applied.rows.map((row) => Number(row["version"])));

  const newlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    const tx = await client.transaction("write");
    try {
      await tx.executeMultiple(migration.sql);
      await tx.execute({
        sql: "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)",
        args: [migration.version, migration.name, nowMs],
      });
      await tx.commit();
      newlyApplied.push(migration.version);
    } catch (error) {
      await tx.rollback();
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  return newlyApplied;
}
