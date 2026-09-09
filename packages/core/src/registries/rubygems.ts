import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";
import { classifyNotFound } from "../classify.js";
import type { RegistryDescriptor } from "../descriptors.js";

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
 * RubyGems normalization: case preserved (upstream names are
 * `[A-Za-z0-9._-]+` with no run or adjacency restriction, so `--`, `__`, and
 * mixed sequences stay distinct legal spellings — same-character runs merely
 * collapse for squat-resistance). Whitespace runs collapse to the canonical
 * hyphen. Upstream additionally bans leading and trailing separators; the
 * leading ban is covered by the first-character check, trailing is explicit.
 * Names that could not be published are rejected with a reason.
 */
export function normalizeRubygemsName(value: string): RegistryValidation {
  const collapsed = value.trim().replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/_{2,}/g, "_");
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[A-Za-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters RubyGems does not allow." };
  }
  if (/[._-]$/.test(collapsed)) {
    return { ok: false, reason: "Name cannot end with a separator." };
  }
  return { ok: true, name: collapsed };
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

/**
 * RubyGems registry descriptor (server venue). Classification uses the shared
 * not-found predicate; names preserve case, so the venue's own normalizer is
 * bound (the generic default would wrongly lowercase).
 */
export const RUBYGEMS_DESCRIPTOR: RegistryDescriptor = {
  id: "rubygems",
  label: "RubyGems",
  language: "Ruby",
  venue: "server",
  normalize: normalizeRubygemsName,
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://rubygems.org",
  checkUrl: (name, origin = "https://rubygems.org") =>
    `${origin}/api/v1/gems/${encodeURIComponent(name)}.json`,
  link: (name) => `https://rubygems.org/gems/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};
