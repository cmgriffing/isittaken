import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

export interface NugetRegistryOptions {
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
 * NuGet normalization: case-insensitive, so names are lowercased. Names that
 * could not be published are rejected with a reason.
 */
export function normalizeNugetName(value: string): RegistryValidation {
  const collapsed = value.trim().toLowerCase();
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9._-]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters NuGet does not allow." };
  }
  if (collapsed.endsWith(".")) {
    return { ok: false, reason: "Name cannot end with a dot." };
  }
  return { ok: true, name: collapsed };
}

/**
 * NuGet registry adapter. Exact venue: 200 with a `versions` array is taken,
 * the documented 404 is available, and every ambiguous response is unknown.
 */
export function createNugetRegistry(options: NugetRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "nuget",
    validate(value: string): RegistryValidation {
      return normalizeNugetName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/v3-flatcontainer/${encodeURIComponent(name)}/index.json`, {
        venue: "nuget",
        fetch: doFetch,
        clock,
        async confirmsPresence(response: Response): Promise<boolean> {
          const payload: unknown = await response.json();
          return (
            typeof payload === "object" &&
            payload !== null &&
            Array.isArray((payload as { versions?: unknown }).versions)
          );
        },
      });
    },
  };
}
