import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";
import { classifyNotFound, DEFAULT_MAX_NAME_LENGTH } from "../classify.js";
import type { RegistryDescriptor } from "../descriptors.js";

export interface HexRegistryOptions {
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
 * Hex normalization. Hex package names validate against `^[a-z][a-z0-9_]*$`
 * upstream: a lowercase letter start followed only by `[a-z0-9_]`. Hyphens
 * and dots are NOT valid Hex names (a hyphenated name gets a plain 404 from
 * Hex, which would falsely classify as available), so they are rejected here.
 * Whitespace runs collapse to the underscore Hex treats as its separator, and
 * consecutive underscore runs (`__`) collapse to one because the upstream
 * regex places no restriction on underscore runs. Digits are only allowed
 * after a leading letter.
 */
export function normalizeHexName(value: string): RegistryValidation {
  const name = value.trim().replace(/\s+/g, "_").replace(/_{2,}/g, "_").toLowerCase();
  if (name.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (name.length > DEFAULT_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds the ${DEFAULT_MAX_NAME_LENGTH}-character limit.`,
    };
  }
  if (!/^[a-z]/.test(name)) {
    return { ok: false, reason: "Hex names must start with a letter." };
  }
  if (name.includes("-")) {
    return { ok: false, reason: "Hex names cannot contain hyphens." };
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    return { ok: false, reason: "Name contains characters Hex does not allow." };
  }
  return { ok: true, name };
}

/**
 * Hex registry adapter. Exact venue: 200 with a parseable package payload is
 * taken, the documented 404 is available, and every ambiguous response is
 * unknown.
 */
export function createHexRegistry(options: HexRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "hex",
    validate(value: string): RegistryValidation {
      return normalizeHexName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/api/packages/${encodeURIComponent(name)}`, {
        venue: "hex",
        fetch: doFetch,
        clock,
      });
    },
  };
}

/**
 * Hex registry descriptor (server venue). Package names are lowercase and
 * validate per the reconciled Hex rule; classification uses the shared
 * not-found predicate.
 */
export const HEX_DESCRIPTOR: RegistryDescriptor = {
  id: "hex",
  label: "Hex",
  language: "Elixir",
  venue: "server",
  normalize: normalizeHexName,
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://hex.pm",
  checkUrl: (name, origin = "https://hex.pm") =>
    `${origin}/api/packages/${encodeURIComponent(name)}`,
  link: (name) => `https://hex.pm/packages/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};
