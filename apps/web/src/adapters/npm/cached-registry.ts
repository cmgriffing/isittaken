import {
  decodeVersionedValue,
  encodeVersionedValue,
  type PackageRegistry,
  type RegistryLookupResult,
} from "@isittaken/core";
import type { CacheRepository, CacheWritePolicy } from "../../ports";

export const NPM_CACHE_VALUE_VERSION = 1;

interface NpmCacheData {
  status: "available" | "taken";
  checkedAtMs: number;
}

export interface CachedNpmRegistryOptions {
  /** The transport-neutral npm registry (from @isittaken/core). */
  registry: PackageRegistry;
  cache: CacheRepository;
  cachePolicies: {
    "npm-available": CacheWritePolicy;
    "npm-taken": CacheWritePolicy;
  };
}

function cacheFamilyFor(status: NpmCacheData["status"]): "npm-available" | "npm-taken" {
  return status === "available" ? "npm-available" : "npm-taken";
}

/**
 * Caching decorator over the transport-neutral npm registry. Preserves the
 * exact previous behavior of the web app's npm cache path: read-through with
 * the `npm-available` / `npm-taken` families, key `v1:name:<name>`, a
 * versioned envelope, only `available`/`taken` results cached with the
 * original check time preserved, and cache read/write failures silently
 * degrading to an upstream lookup.
 */
export function createCachedNpmRegistry(options: CachedNpmRegistryOptions): PackageRegistry {
  const { registry, cache, cachePolicies } = options;

  return {
    id: registry.id,
    validate: (value) => registry.validate(value),
    async lookup(name: string): Promise<RegistryLookupResult> {
      const cacheKey = `v${NPM_CACHE_VALUE_VERSION}:name:${name}`;

      try {
        const cached = await cache.read("npm-available", cacheKey);
        if (cached?.status === "fresh") {
          const data = decodeVersionedValue<NpmCacheData>(
            cached.valueJson,
            NPM_CACHE_VALUE_VERSION,
          );
          if (data && data.status === "available") {
            return { status: data.status, checkedAtMs: data.checkedAtMs };
          }
        }
        const cachedTaken = await cache.read("npm-taken", cacheKey);
        if (cachedTaken?.status === "fresh") {
          const data = decodeVersionedValue<NpmCacheData>(
            cachedTaken.valueJson,
            NPM_CACHE_VALUE_VERSION,
          );
          if (data && data.status === "taken") {
            return { status: data.status, checkedAtMs: data.checkedAtMs };
          }
        }
      } catch {
        // Cache failure degrades to an upstream lookup.
      }

      const result = await registry.lookup(name);

      if (result.status === "available" || result.status === "taken") {
        try {
          await cache.write(
            cacheFamilyFor(result.status),
            cacheKey,
            encodeVersionedValue(NPM_CACHE_VALUE_VERSION, {
              status: result.status,
              checkedAtMs: result.checkedAtMs,
            } satisfies NpmCacheData),
            cachePolicies[cacheFamilyFor(result.status)],
          );
        } catch {
          // Cache write failure never fails the lookup.
        }
      }

      return result;
    },
  };
}
