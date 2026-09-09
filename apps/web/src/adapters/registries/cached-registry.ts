import {
  decodeVersionedValue,
  encodeVersionedValue,
  type PackageRegistry,
  type RegistryLookupResult,
} from "@isittaken/core";
import type { CacheRepository, CacheWritePolicy } from "../../ports";

export const REGISTRY_CACHE_VALUE_VERSION = 1;

interface RegistryCacheData {
  status: "available" | "taken";
  checkedAtMs: number;
}

export interface RegistryCachePolicies {
  available: CacheWritePolicy;
  taken: CacheWritePolicy;
}

export interface CachedRegistryOptions {
  /** The transport-neutral registry adapter (from @isittaken/core). */
  registry: PackageRegistry;
  cache: CacheRepository;
  cachePolicies: RegistryCachePolicies;
}

/**
 * Cache key for a checked name. The registry id is embedded so all server
 * venues share the two generic families (`registry-available` /
 * `registry-taken`) without key collisions.
 */
export function registryCacheKey(registryId: string, name: string): string {
  return `${registryId}:v${REGISTRY_CACHE_VALUE_VERSION}:name:${name}`;
}

/**
 * Caching decorator over a transport-neutral `PackageRegistry` from
 * `@isittaken/core`. Caching is a web concern (decision D5): core stays
 * cache-free, and this decorator re-adds the cache at the web boundary.
 *
 * Cache design: the verdict lives in the cached value and the same key is
 * written to both generic families with the per-verdict freshness TTL applied
 * at write time. Reads therefore need a single family lookup and trust the
 * verdict stored in the value; a verdict flip overwrites the entry under the
 * same key. Only `available`/`taken` results are cached; `unknown` and
 * `invalid` are never written. Cache read/write failures silently degrade to
 * an upstream lookup.
 */
export function createCachedRegistry(options: CachedRegistryOptions): PackageRegistry {
  const { registry, cache, cachePolicies } = options;

  function cachePolicyForStatus(status: RegistryCacheData["status"]): CacheWritePolicy {
    return status === "available" ? cachePolicies.available : cachePolicies.taken;
  }

  async function readCached(name: string): Promise<RegistryLookupResult | null> {
    try {
      const cached = await cache.read("registry-available", registryCacheKey(registry.id, name));
      if (cached.status !== "fresh") return null;
      const data = decodeVersionedValue<RegistryCacheData>(
        cached.valueJson,
        REGISTRY_CACHE_VALUE_VERSION,
      );
      if (!data) return null;
      if (data.status !== "available" && data.status !== "taken") return null;
      if (typeof data.checkedAtMs !== "number") return null;
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
    const valueJson = encodeVersionedValue(REGISTRY_CACHE_VALUE_VERSION, {
      status,
      checkedAtMs,
    } satisfies RegistryCacheData);
    const key = registryCacheKey(registry.id, name);
    const policy = cachePolicyForStatus(status);
    try {
      await Promise.all([
        cache.write("registry-available", key, valueJson, policy),
        cache.write("registry-taken", key, valueJson, policy),
      ]);
    } catch {
      // Cache write failure never fails the lookup.
    }
  }

  return {
    id: registry.id,
    validate: (value) => registry.validate(value),
    async lookup(name: string): Promise<RegistryLookupResult> {
      const cached = await readCached(name);
      if (cached) return cached;

      const result = await registry.lookup(name);

      if (result.status === "available" || result.status === "taken") {
        await writeCached(name, result.status, result.checkedAtMs);
      }
      return result;
    },
  };
}
