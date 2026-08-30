import type {
  CacheRepository,
  CacheWritePolicy,
  Clock,
  PackageRegistry,
  RegistryValidation,
} from "../../domain/ports";
import type { RegistryLookupResult } from "../../domain/types";
import {
  logUpstreamError,
  readUpstreamErrorSnippet,
  sanitizeUpstreamSnippet,
} from "../../lib/upstream";
import { logger } from "../../lib/logger";

export const NPM_CACHE_VALUE_VERSION = 1;

const MAX_NAME_LENGTH = 214;

interface NpmCacheData {
  status: "available" | "taken";
  checkedAtMs: number;
}

export interface NpmRegistryOptions {
  /** Fixed registry origin; callers cannot override it per request. */
  origin: string;
  timeoutMs: number;
  clock: Clock;
  cache?: CacheRepository;
  cachePolicies?: {
    "npm-available": CacheWritePolicy;
    "npm-taken": CacheWritePolicy;
  };
  fetchImpl?: typeof fetch;
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
 * Results are cached in the npm-available / npm-taken families with the
 * original check time preserved.
 */
export function createNpmRegistry(options: NpmRegistryOptions): PackageRegistry {
  const { origin, timeoutMs, clock } = options;
  const doFetch = options.fetchImpl ?? fetch;

  function cacheFamilyFor(status: NpmCacheData["status"]): "npm-available" | "npm-taken" {
    return status === "available" ? "npm-available" : "npm-taken";
  }

  async function lookupUpstream(name: string): Promise<RegistryLookupResult> {
    let response: Response;
    try {
      response = await doFetch(`${origin}/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
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
      const snippet = await readUpstreamErrorSnippet(response);
      logUpstreamError("npm", response.status, snippet, { name });
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "npm registry rate limit exceeded.",
      };
    }

    if (response.status !== 200) {
      const snippet = await readUpstreamErrorSnippet(response);
      logUpstreamError("npm", response.status, snippet, { name });
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `npm registry responded with status ${response.status}.`,
      };
    }

    // 200: metadata proves presence only if the body is valid JSON metadata.
    const bodyText = await response.text();
    try {
      const payload: unknown = JSON.parse(bodyText) as unknown;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        logUpstreamError("npm", response.status, sanitizeUpstreamSnippet(bodyText), {
          name,
          problem: "unexpected_shape",
        });
        return {
          status: "unknown",
          checkedAtMs: clock.nowMs(),
          reason: "npm registry returned an ambiguous response.",
        };
      }
      return { status: "taken", checkedAtMs: clock.nowMs() };
    } catch {
      logUpstreamError("npm", response.status, sanitizeUpstreamSnippet(bodyText), {
        name,
        problem: "non_json_body",
      });
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
      const cacheKey = `v${NPM_CACHE_VALUE_VERSION}:name:${name}`;

      try {
        const cached = await options.cache?.read("npm-available", cacheKey);
        if (cached?.status === "fresh") {
          const data = decodeCache(cached.valueJson);
          if (data && data.status === "available") {
            logger.debug("npm_cache_hit", { family: "npm-available", name });
            return { status: data.status, checkedAtMs: data.checkedAtMs };
          }
        }
        const cachedTaken = await options.cache?.read("npm-taken", cacheKey);
        if (cachedTaken?.status === "fresh") {
          const data = decodeCache(cachedTaken.valueJson);
          if (data && data.status === "taken") {
            logger.debug("npm_cache_hit", { family: "npm-taken", name });
            return { status: data.status, checkedAtMs: data.checkedAtMs };
          }
        }
      } catch {
        // Cache failure degrades to an upstream lookup.
      }

      const result = await lookupUpstream(name);

      if (
        (result.status === "available" || result.status === "taken") &&
        options.cache &&
        options.cachePolicies
      ) {
        try {
          await options.cache.write(
            cacheFamilyFor(result.status),
            cacheKey,
            JSON.stringify({
              version: NPM_CACHE_VALUE_VERSION,
              data: {
                status: result.status,
                checkedAtMs: result.checkedAtMs,
              } satisfies NpmCacheData,
            }),
            options.cachePolicies[cacheFamilyFor(result.status)] as CacheWritePolicy,
          );
        } catch {
          // Cache write failure never fails the lookup.
        }
      }

      return result;
    },
  };
}

function decodeCache(valueJson: string): NpmCacheData | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as { version?: unknown; data?: unknown };
    if (envelope.version !== NPM_CACHE_VALUE_VERSION) return null;
    const data = envelope.data as NpmCacheData | undefined;
    if (!data || (data.status !== "available" && data.status !== "taken")) return null;
    if (typeof data.checkedAtMs !== "number") return null;
    return data;
  } catch {
    return null;
  }
}
