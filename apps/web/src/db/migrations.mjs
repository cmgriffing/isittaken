/**
 * Versioned schema migrations. Plain .mjs so both the TypeScript application
 * and the plain-Node migration CLI share this single source of truth.
 *
 * Timestamps are UTC epoch milliseconds everywhere.
 *
 * @typedef {{ version: number, name: string, sql: string }} Migration
 * @type {Migration[]}
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: "init-core-tables",
    sql: `
CREATE TABLE IF NOT EXISTS cache_entries (
  family TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (family, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_cache_entries_family_expires
  ON cache_entries (family, expires_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ai_usage_buckets (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_type, subject_id, window_kind, period_start)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_buckets_period
  ON ai_usage_buckets (window_kind, period_start);
`,
  },
];
