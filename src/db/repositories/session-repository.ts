import type { Client } from "@libsql/client";
import type { SessionRecord, SessionRepository } from "../../domain/ports";

interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    createdAtMs: row.created_at,
    expiresAtMs: row.expires_at,
    lastSeenAtMs: row.last_seen_at,
  };
}

/**
 * Application sessions persist only a one-way representation (hash) of the
 * opaque session credential. Expiry is enforced at read time.
 */
export class LibsqlSessionRepository implements SessionRepository {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async create(record: SessionRecord): Promise<void> {
    await this.#client.execute({
      sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        record.tokenHash,
        record.userId,
        record.createdAtMs,
        record.expiresAtMs,
        record.lastSeenAtMs,
      ],
    });
  }

  async findValid(tokenHash: string, nowMs: number): Promise<SessionRecord | null> {
    const result = await this.#client.execute({
      sql: `SELECT token_hash, user_id, created_at, expires_at, last_seen_at
            FROM sessions WHERE token_hash = ?`,
      args: [tokenHash],
    });
    const row = result.rows[0] as unknown as SessionRow | undefined;
    if (!row) return null;
    if (nowMs >= row.expires_at) return null;
    return toRecord(row);
  }

  async touch(tokenHash: string, nowMs: number): Promise<void> {
    await this.#client.execute({
      sql: "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
      args: [nowMs, tokenHash],
    });
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.#client.execute({
      sql: "DELETE FROM sessions WHERE token_hash = ?",
      args: [tokenHash],
    });
  }
}
