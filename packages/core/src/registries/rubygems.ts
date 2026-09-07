import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

export interface RubygemsRegistryOptions {
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
 * RubyGems normalization: trim only, case preserved. Names that could not be
 * published are rejected with a reason.
 */
export function normalizeRubygemsName(value: string): RegistryValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[A-Za-z0-9]/.test(trimmed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return { ok: false, reason: "Name contains characters RubyGems does not allow." };
  }
  return { ok: true, name: trimmed };
}

/**
 * RubyGems registry adapter. Exact venue: 200 with a parseable gem payload is
 * taken, the documented 404 is available, and every ambiguous response is
 * unknown.
 */
export function createRubygemsRegistry(options: RubygemsRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "rubygems",
    validate(value: string): RegistryValidation {
      return normalizeRubygemsName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/api/v1/gems/${encodeURIComponent(name)}.json`, {
        venue: "rubygems",
        fetch: doFetch,
        clock,
      });
    },
  };
}
