import type { RegistryDescriptor } from "../../domain/registries";
import { normalizerFor } from "../../domain/registries";
import type {
  CacheRepository,
  CacheWritePolicy,
  Clock,
  PackageRegistry,
  RegistryValidation,
} from "../../domain/ports";
import type { RegistryLookupResult } from "../../domain/types";
import { encodeVersionedValue, decodeVersionedValue } from "../../domain/cache-value";
import { logger } from "../../lib/logger";
import { logUpstreamError, sanitizeUpstreamSnippet } from "../../lib/upstream";

/**
 * Shared server-venue registry adapter. Every server-venue adapter is this
 * wrapper plus its descriptor: it owns the cache envelope, the upstream
 * request (timeout, User-Agent), and the conservative classification of
 * transport failures into `unknown`. Adapters wrap, never re-implement,
 * the descriptor's classification.
 */

export const REGISTRY_CACHE_VALUE_VERSION = 1;

interface RegistryCacheData {
  status: "available" | "taken";
  checkedAtMs: number;
}

export interface RegistryCachePolicies {
  available: CacheWritePolicy;
  taken: CacheWritePolicy;
}

export interface ServerRegistryAdapterOptions {
  descriptor: RegistryDescriptor;
  /** Upstream origin override (tests, ops); defaults to the descriptor's. */
  origin?: string;
  timeoutMs: number;
  clock: Clock;
  cache?: CacheRepository;
  cachePolicies?: RegistryCachePolicies;
  fetchImpl?: typeof fetch;
}

/**
 * Cache key for a checked name. The registry id is embedded so all
 * registries share the two generic families.
 */
export function registryCacheKey(registryId: string, name: string): string {
  return `${registryId}:v${REGISTRY_CACHE_VALUE_VERSION}:name:${name}`;
}

/**
 * Build a server-venue `PackageRegistry` from a descriptor.
 *
 * Cache design (per decision D5): the verdict lives in the cached value and
 * the same key is written to both generic families — `registry-available` and
 * `registry-taken` — with the per-verdict freshness TTL applied at write
 * time. Reads therefore need a single family lookup and trust the verdict
 * stored in the value; a verdict flip overwrites the entry under the same key.
 */
export function createServerRegistryAdapter(
  options: ServerRegistryAdapterOptions,
): PackageRegistry {
  const { descriptor, clock } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const validate = normalizerFor(descriptor);

  function cachePolicyForStatus(status: RegistryCacheData["status"]): CacheWritePolicy {
    return status === "available"
      ? (options.cachePolicies?.available ?? { freshForMs: 0, retainForMs: 0 })
      : (options.cachePolicies?.taken ?? { freshForMs: 0, retainForMs: 0 });
  }

  async function readCached(name: string): Promise<RegistryLookupResult | null> {
    if (!options.cache) return null;
    try {
      const cached = await options.cache.read(
        "registry-available",
        registryCacheKey(descriptor.id, name),
      );
      if (cached.status !== "fresh") return null;
      const data = decodeVersionedValue<RegistryCacheData>(
        cached.valueJson,
        REGISTRY_CACHE_VALUE_VERSION,
      );
      if (!data) return null;
      if (data.status !== "available" && data.status !== "taken") return null;
      if (typeof data.checkedAtMs !== "number") return null;
      logger.debug("registry_cache_hit", { registry: descriptor.id, name });
      return { status: data.status, checkedAtMs: data.checkedAtMs };
    } catch {
      // Cache failure degrades to an upstream lookup.
      return null;
    }
  }

  async function writeCached(
    name: string,
    status: RegistryCacheData["status"],
    checkedAtMs: number,
  ): Promise<void> {
    if (!options.cache || !options.cachePolicies) return;
    const valueJson = encodeVersionedValue(REGISTRY_CACHE_VALUE_VERSION, {
      status,
      checkedAtMs,
    } satisfies RegistryCacheData);
    const key = registryCacheKey(descriptor.id, name);
    try {
      await Promise.all([
        options.cache.write("registry-available", key, valueJson, cachePolicyForStatus(status)),
        options.cache.write("registry-taken", key, valueJson, cachePolicyForStatus(status)),
      ]);
    } catch {
      // Cache write failure never fails the lookup.
    }
  }

  async function lookupUpstream(name: string): Promise<RegistryLookupResult> {
    const url = descriptor.checkUrl(name, options.origin ?? descriptor.checkOrigin);
    const headers: Record<string, string> = { accept: "application/json" };
    if (descriptor.userAgent) headers["user-agent"] = descriptor.userAgent;

    let response: Response;
    try {
      response = await doFetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs),
        headers,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut
          ? `${descriptor.label} request timed out.`
          : `${descriptor.label} request failed.`,
      };
    }

    // Read the body once; classification receives both parsed JSON and a
    // sanitized text snippet so shape rules stay shared across venues.
    const text = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }

    const classification = descriptor.classify({ name, status: response.status, json, text });
    if (classification.status === "unknown") {
      logUpstreamError(descriptor.id, response.status, sanitizeUpstreamSnippet(text), { name });
    }
    return {
      status: classification.status,
      checkedAtMs: clock.nowMs(),
      ...(classification.reason ? { reason: classification.reason } : {}),
    };
  }

  return {
    id: descriptor.id,
    validate(value: string): RegistryValidation {
      return validate(value);
    },
    async lookup(rawName: string): Promise<RegistryLookupResult> {
      // Defense in depth: callers are expected to pass registry-normalized
      // names, but an invalid name must never reach the upstream registry.
      const validation = validate(rawName);
      if (!validation.ok) {
        return {
          status: "invalid",
          checkedAtMs: clock.nowMs(),
          reason: validation.reason,
        };
      }
      const name = validation.name;

      const cached = await readCached(name);
      if (cached) return cached;

      const result = await lookupUpstream(name);

      if (result.status === "available" || result.status === "taken") {
        await writeCached(name, result.status, result.checkedAtMs);
      }
      return result;
    },
  };
}
