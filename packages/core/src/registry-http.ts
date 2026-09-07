/**
 * Shared HTTP fetch helper for registry adapters. Injects an identifiable
 * User-Agent, `Accept: application/json`, and a timeout into every upstream
 * request. The version and repository URL are supplied by the calling app so
 * core stays transport-pure and version drift is avoided.
 */

export interface RegistryFetchOptions {
  /** Supplied by the calling app, never hardcoded in core. */
  version: string;
  repoUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Full User-Agent override (per-venue override capability). */
  userAgent?: string;
}

export type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Build a fetch function bound to the given options. Per call:
 *   - default User-Agent `isittaken/<version> (+<repo-url>)` (options.userAgent wins)
 *   - `Accept: application/json`
 *   - signal = init?.signal ?? AbortSignal.timeout(timeoutMs)
 *   - caller's init.headers/init.signal override the defaults (caller headers
 *     spread last); all other init fields (method, body, ...) are preserved.
 */
export function createRegistryFetch(options: RegistryFetchOptions): RegistryFetch {
  const doFetch = options.fetchImpl ?? fetch;
  const defaultUserAgent = `isittaken/${options.version} (+${options.repoUrl})`;
  const userAgent = options.userAgent ?? defaultUserAgent;

  return (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

    return doFetch(url, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(options.timeoutMs),
    });
  };
}
