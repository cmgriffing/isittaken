import type { Client } from "@libsql/client";
import type { IdGenerator, UserRecord, UserRepository } from "../../domain/ports";

interface UserRow {
  id: string;
  github_id: string;
  github_login: string;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    githubId: row.github_id,
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

/**
 * Users are identified by GitHub's immutable numeric ID; login and avatar are
 * mutable display snapshots refreshed on every login.
 */
export class LibsqlUserRepository implements UserRepository {
  readonly #client: Client;
  readonly #ids: IdGenerator;

  constructor(client: Client, ids: IdGenerator) {
    this.#client = client;
    this.#ids = ids;
  }

  async upsertByGithubId(
    input: { githubId: string; githubLogin: string; avatarUrl: string | null },
    nowMs: number,
  ): Promise<UserRecord> {
    const updated = await this.#client.execute({
      sql: `UPDATE users SET github_login = ?, avatar_url = ?, updated_at = ?
            WHERE github_id = ?
            RETURNING id, github_id, github_login, avatar_url, created_at, updated_at`,
      args: [input.githubLogin, input.avatarUrl, nowMs, input.githubId],
    });
    const updatedRow = updated.rows[0] as unknown as UserRow | undefined;
    if (updatedRow) return toRecord(updatedRow);

    const id = this.#ids.newId();
    const inserted = await this.#client.execute({
      sql: `INSERT INTO users (id, github_id, github_login, avatar_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id, github_id, github_login, avatar_url, created_at, updated_at`,
      args: [id, input.githubId, input.githubLogin, input.avatarUrl, nowMs, nowMs],
    });
    const insertedRow = inserted.rows[0] as unknown as UserRow | undefined;
    if (!insertedRow) throw new Error("Failed to upsert user by GitHub ID.");
    return toRecord(insertedRow);
  }

  async getById(id: string): Promise<UserRecord | null> {
    const result = await this.#client.execute({
      sql: "SELECT id, github_id, github_login, avatar_url, created_at, updated_at FROM users WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0] as unknown as UserRow | undefined;
    return row ? toRecord(row) : null;
  }
}
