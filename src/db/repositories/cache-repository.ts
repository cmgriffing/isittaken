import type { Client } from "@libsql/client";
import type { CacheFamily, CacheRead, CacheRepository, CacheWritePolicy } from "../../domain/ports";

interface CacheRow {
  value_json: string;
  fresh_until: number;
  expires_at: number;
}

/**
 * SQLite/libSQL-backed cache repository. Freshness is enforced on every read
 * against the caller's clock: a stale row is never served as fresh just
 * because pruning has not deleted it yet. Use {@link createCacheRepository}
 * to bind the clock and obtain the port implementation.
 */
export class LibsqlCacheRepository {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async read(family: CacheFamily, key: string, nowMs: number): Promise<CacheRead> {
    const result = await this.#client.execute({
      sql: "SELECT value_json, fresh_until, expires_at FROM cache_entries WHERE family = ? AND cache_key = ?",
      args: [family, key],
    });
    const row = result.rows[0] as unknown as CacheRow | undefined;
    if (!row) return { status: "miss" };

    if (nowMs < row.fresh_until) {
      return { status: "fresh", valueJson: row.value_json };
    }
    if (nowMs < row.expires_at) {
      return { status: "stale", valueJson: row.value_json };
    }
    return { status: "expired" };
  }

  async write(
    family: CacheFamily,
    key: string,
    valueJson: string,
    policy: CacheWritePolicy,
    nowMs: number,
  ): Promise<void> {
    const freshUntil = nowMs + policy.freshForMs;
    const expiresAt = nowMs + policy.freshForMs + policy.retainForMs;
    await this.#client.execute({
      sql: `INSERT INTO cache_entries (family, cache_key, value_json, created_at, fresh_until, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (family, cache_key) DO UPDATE SET
              value_json = excluded.value_json,
              created_at = excluded.created_at,
              fresh_until = excluded.fresh_until,
              expires_at = excluded.expires_at`,
      args: [family, key, valueJson, nowMs, freshUntil, expiresAt],
    });
  }
}

/** Bind clock injection and expose the {@link CacheRepository} port. */
export function createCacheRepository(client: Client, clock: { nowMs(): number }): CacheRepository {
  const repo = new LibsqlCacheRepository(client);
  return {
    read: (family, key) => repo.read(family, key, clock.nowMs()),
    write: (family, key, valueJson, policy) =>
      repo.write(family, key, valueJson, policy, clock.nowMs()),
  };
}
