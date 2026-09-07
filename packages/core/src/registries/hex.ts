import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

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
 * Hex normalization: lowercase, underscores allowed. Names that could not be
 * published are rejected with a reason.
 */
export function normalizeHexName(value: string): RegistryValidation {
  const collapsed = value.trim().toLowerCase();
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9_]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters Hex does not allow." };
  }
  return { ok: true, name: collapsed };
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
