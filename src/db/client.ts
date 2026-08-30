import { createClient, type Client } from "@libsql/client";
import type { ServerConfig } from "../config/server";

/**
 * Create a libSQL client for the configured database URL. Local development
 * uses `file:` SQLite URLs; deployed environments use Turso `libsql:` URLs
 * with an auth token. Callers never construct clients themselves.
 */
export function createDbClient(config: ServerConfig): Client {
  const authToken =
    config.database.authToken && config.database.authToken.length > 0
      ? config.database.authToken
      : undefined;
  return createClient({ url: config.database.url, authToken });
}

let cached: { url: string; token?: string; client: Client } | undefined;

/** Memoized client keyed by database URL (avoids re-connecting per request). */
export function getDbClient(config: ServerConfig): Client {
  const token = config.database.authToken;
  if (cached && cached.url === config.database.url && cached.token === token) {
    return cached.client;
  }
  const client = createDbClient(config);
  cached = { url: config.database.url, token, client };
  return client;
}
