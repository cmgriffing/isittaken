import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";

export interface PackagistRegistryOptions {
  /** Search API origin (bare-word fuzzy lookups). */
  searchOrigin: string;
  /** P2 metadata origin (qualified exact lookups). */
  p2Origin: string;
  timeoutMs: number;
  clock: Clock;
  /** App-supplied version for the User-Agent (never hardcoded in core). */
  version: string;
  repoUrl: string;
  fetchImpl?: typeof fetch;
  /** Full User-Agent override. */
  userAgent?: string;
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Packagist normalization: lowercase, spaces are invalid. A bare word is a
 * search term; `vendor/name` (exactly one slash) is a qualified package.
 */
export function normalizePackagistName(value: string): RegistryValidation {
  const collapsed = value.trim().toLowerCase();
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (collapsed.includes(" ")) {
    return { ok: false, reason: "Name cannot contain spaces." };
  }
  const segments = collapsed.split("/");
  if (segments.length > 2) {
    return { ok: false, reason: "Packagist names are vendor/name." };
  }
  if (segments.length === 2) {
    const [vendor, name] = segments;
    if (!vendor || !name) {
      return { ok: false, reason: "Packagist names are vendor/name." };
    }
    if (!SEGMENT.test(vendor) || !SEGMENT.test(name)) {
      return { ok: false, reason: "Name contains characters Packagist does not allow." };
    }
    if (vendor.endsWith("-") || name.endsWith("-")) {
      return { ok: false, reason: "Segments cannot end with a hyphen." };
    }
    return { ok: true, name: collapsed };
  }
  if (!SEGMENT.test(collapsed)) {
    return { ok: false, reason: "Name contains characters Packagist does not allow." };
  }
  if (collapsed.endsWith("-")) {
    return { ok: false, reason: "Name cannot end with a hyphen." };
  }
  return { ok: true, name: collapsed };
}

/**
 * Packagist registry adapter. A bare word is a fuzzy search-index check; a
 * qualified `vendor/name` is an exact p2 metadata lookup.
 */
export function createPackagistRegistry(options: PackagistRegistryOptions): PackageRegistry {
  const { searchOrigin, p2Origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  async function lookupBare(name: string): Promise<RegistryLookupResult> {
    let response: Response;
    try {
      response = await doFetch(`${searchOrigin}/search.json?q=${encodeURIComponent(name)}`);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "packagist request timed out." : "packagist request failed.",
      };
    }

    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "packagist rate limit exceeded.",
      };
    }
    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `packagist responded with status ${response.status}.`,
      };
    }

    try {
      const payload: unknown = await response.json();
      const results = (payload as { results?: unknown }).results;
      if (!Array.isArray(results)) {
        return {
          status: "unknown",
          checkedAtMs: clock.nowMs(),
          reason: "packagist returned an ambiguous response.",
        };
      }
      const matched = results.some((entry) => {
        const entryName = (entry as { name?: unknown }).name;
        if (typeof entryName !== "string") return false;
        const finalSegment = entryName.slice(entryName.lastIndexOf("/") + 1);
        return finalSegment.toLowerCase() === name;
      });
      if (matched) {
        return {
          status: "taken",
          checkedAtMs: clock.nowMs(),
          fuzzy: true,
          reason: "matched via the Packagist search index (search indexes may lag the registry)",
        };
      }
      return {
        status: "available",
        checkedAtMs: clock.nowMs(),
        fuzzy: true,
        reason: "not matched in the Packagist search index (search indexes may lag the registry)",
      };
    } catch {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "packagist returned an ambiguous response.",
      };
    }
  }

  return {
    id: "packagist",
    validate(value: string): RegistryValidation {
      return normalizePackagistName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      if (name.includes("/")) {
        const [vendor, pkg] = name.split("/");
        return lookupPresence(`${p2Origin}/p2/${vendor}/${pkg}.json`, {
          venue: "packagist",
          fetch: doFetch,
          clock,
        });
      }
      return lookupBare(name);
    },
  };
}
