import type { CacheFamily, CacheWritePolicy } from "./ports";
import type { ServerConfig } from "../config/server";

/**
 * Source-specific cache policies. Freshness and retention are configured
 * independently; registry-available entries get the shortest freshness
 * because an available name can become taken at any moment. Registry verdicts
 * carry their own per-entry TTL at write time (from the descriptor or its
 * per-registry override), so these policies are the generic fallback.
 */
const RETENTION_MULTIPLIER: Record<CacheFamily, number> = {
  wordnik: 4,
  openrouter: 4,
  "registry-available": 12,
  "registry-taken": 7,
};

export function cachePolicyFor(family: CacheFamily, config: ServerConfig): CacheWritePolicy {
  const freshForMs = freshFor(family, config);
  return {
    freshForMs,
    retainForMs: freshForMs * RETENTION_MULTIPLIER[family],
  };
}

/** Retention window for a custom freshness TTL (per-registry overrides). */
export function retentionFor(family: CacheFamily, freshForMs: number): number {
  return freshForMs * RETENTION_MULTIPLIER[family];
}

export function freshFor(family: CacheFamily, config: ServerConfig): number {
  switch (family) {
    case "wordnik":
      return config.cache.ttl.wordnikMs;
    case "openrouter":
      return config.cache.ttl.openrouterMs;
    case "registry-available":
      return config.cache.ttl.registryAvailableMs;
    case "registry-taken":
      return config.cache.ttl.registryTakenMs;
  }
}
