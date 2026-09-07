import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";

const MAX_NAME_LENGTH = 214;

export interface NpmRegistryOptions {
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
 * npm unscoped-name normalization and validation. Whitespace runs collapse to
 * hyphens so multiword suggestions become plausible package names. Names that
 * could not be published unscoped are rejected with a reason; scoped names
 * are explicitly unsupported.
 */
export function normalizeNpmName(value: string): RegistryValidation {
  const collapsed = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (collapsed.includes("/")) {
    return { ok: false, reason: "Scoped npm names are not supported." };
  }
  if (collapsed.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Name exceeds npm's ${MAX_NAME_LENGTH}-character limit.` };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9\-._]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters npm does not allow." };
  }
  if (collapsed.startsWith(".") || collapsed.startsWith("_")) {
    return { ok: false, reason: "Name cannot start with a dot or underscore." };
  }
  if (collapsed.endsWith("-")) {
    return { ok: false, reason: "Name cannot end with a hyphen." };
  }
  return { ok: true, name: collapsed };
}

/**
 * npm registry adapter. Classification is conservative:
 *   200 with parseable metadata -> taken
 *   documented 404 not-found    -> available
 *   rate limits, timeouts, transport errors, and every ambiguous response
 *                               -> unknown (never presented as available)
 * Caching is intentionally absent here; the web app re-adds it via a
 * decorator so core stays transport-pure.
 */
export function createNpmRegistry(options: NpmRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  async function lookupUpstream(name: string): Promise<RegistryLookupResult> {
    let response: Response;
    try {
      response = await doFetch(`${origin}/${encodeURIComponent(name)}`);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "npm registry request timed out." : "npm registry request failed.",
      };
    }

    if (response.status === 404) {
      // npm's documented not-found response for a valid name.
      return { status: "available", checkedAtMs: clock.nowMs() };
    }

    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "npm registry rate limit exceeded.",
      };
    }

    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `npm registry responded with status ${response.status}.`,
      };
    }

    // 200: metadata proves presence only if the body is valid JSON metadata.
    try {
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return {
          status: "unknown",
          checkedAtMs: clock.nowMs(),
          reason: "npm registry returned an ambiguous response.",
        };
      }
      return { status: "taken", checkedAtMs: clock.nowMs() };
    } catch {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "npm registry returned an ambiguous response.",
      };
    }
  }

  return {
    id: "npm",
    validate(value: string): RegistryValidation {
      return normalizeNpmName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupUpstream(name);
    },
  };
}
