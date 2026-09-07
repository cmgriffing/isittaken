import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

export interface CratesRegistryOptions {
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
 * Crates.io normalization: underscores and hyphens denote the same crate, so
 * underscores are canonicalized to hyphens. Names that could not be published
 * are rejected with a reason.
 */
export function normalizeCratesName(value: string): RegistryValidation {
  const collapsed = value.trim().toLowerCase().replace(/_/g, "-");
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9-]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters crates.io does not allow." };
  }
  if (collapsed.endsWith("-")) {
    return { ok: false, reason: "Name cannot end with a hyphen." };
  }
  return { ok: true, name: collapsed };
}

/**
 * Crates.io registry adapter. Exact venue: 200 with a parseable crate payload
 * is taken, the documented 404 is available, and every ambiguous response is
 * unknown. Requests always carry an identifying User-Agent.
 */
export function createCratesRegistry(options: CratesRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "crates",
    validate(value: string): RegistryValidation {
      return normalizeCratesName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/api/v1/crates/${encodeURIComponent(name)}`, {
        venue: "crates",
        fetch: doFetch,
        clock,
      });
    },
  };
}
