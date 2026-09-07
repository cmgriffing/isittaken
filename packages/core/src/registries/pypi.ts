import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

export interface PypiRegistryOptions {
  /** Fixed registry origin; callers cannot override it per request. */
  origin: string;
  timeoutMs: number;
  clock: Clock;
  /** App-supplied version for the User-Agent (never hardcoded in core). */
  version: string;
  repoUrl: string;
  fetchImpl?: typeof fetch;
  /** Full User-Agent override. */
  userAgent?: string;
}

/**
 * PyPI (PEP 503) normalization: casefold, then collapse runs of `-`, `_`, and
 * `.` into a single hyphen. Names that could not be published are rejected
 * with a reason.
 */
export function normalizePypiName(value: string): RegistryValidation {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9-]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters PyPI does not allow." };
  }
  if (collapsed.startsWith("-") || collapsed.endsWith("-")) {
    return { ok: false, reason: "Name cannot start or end with a hyphen." };
  }
  return { ok: true, name: collapsed };
}

/**
 * PyPI registry adapter. Exact venue: 200 with a parseable project payload is
 * taken, the documented 404 is available, and every ambiguous response is
 * unknown.
 */
export function createPypiRegistry(options: PypiRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "pypi",
    validate(value: string): RegistryValidation {
      return normalizePypiName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/pypi/${encodeURIComponent(name)}/json`, {
        venue: "pypi",
        fetch: doFetch,
        clock,
      });
    },
  };
}
