import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";
import { classifyNotFound, isJsonArray, isJsonObject } from "../classify.js";
import type { RegistryDescriptor } from "../descriptors.js";

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
 * NuGet normalization: case-insensitive, so names are lowercased. Upstream IDs
 * validate against `^\w+([.-]\w+)*$` (NuGet.Client PackageIdValidator): word
 * characters (`[A-Za-z0-9_]`, which makes underscores plain legal characters —
 * even adjacent to separators) joined by single `.` or `-` separators.
 * Underscore runs are therefore legal and collapse to one, but hyphen runs,
 * dot runs, adjacent `.`/`-` separators, and leading/trailing separators can
 * never be published, so they are rejected locally instead of being checked
 * (a network check would 404 into a false "available"). Whitespace runs
 * collapse to the canonical `-` separator. Cross-mapping `-`↔`_` is never
 * applied.
 */
export function normalizeNugetName(value: string): RegistryValidation {
  const collapsed = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/_{2,}/g, "_");
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9_]+([.-][a-z0-9_]+)*$/.test(collapsed)) {
    if (/-{2,}/.test(collapsed) || /[.-][.-]/.test(collapsed)) {
      return {
        ok: false,
        reason: "Name contains consecutive separators; NuGet allows only single `.` or `-`.",
      };
    }
    if (/[.-]$/.test(collapsed)) {
      return { ok: false, reason: "Name cannot end with a separator." };
    }
    return { ok: false, reason: "Name contains characters NuGet does not allow." };
  }
  return { ok: true, name: collapsed };
}

/** True for a parsed object body carrying a NuGet `versions` array. */
export function hasNugetVersions(json: unknown): boolean {
  return isJsonObject(json) && isJsonArray(json["versions"]);
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
          return hasNugetVersions(payload);
        },
      });
    },
  };
}

/**
 * NuGet registry descriptor (browser venue; the flat container serves CORS).
 * Both the adapter and the descriptor classify via the shared
 * `hasNugetVersions` shape predicate.
 */
export const NUGET_DESCRIPTOR: RegistryDescriptor = {
  id: "nuget",
  label: "NuGet",
  language: ".NET",
  venue: "browser",
  normalize: normalizeNugetName,
  classify: (input) =>
    classifyNotFound(input, {
      shape: hasNugetVersions,
    }),
  checkOrigin: "https://api.nuget.org",
  checkUrl: (name, origin = "https://api.nuget.org") =>
    `${origin}/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`,
  link: (name) => `https://www.nuget.org/packages/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
};
