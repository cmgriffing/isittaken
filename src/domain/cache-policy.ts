import type { CacheFamily, CacheWritePolicy } from "./ports";
import type { ServerConfig } from "../config/server";

/**
 * Source-specific cache policies. Freshness and retention are configured
 * independently; npm-available entries get the shortest freshness because an
 * available name can become taken at any moment.
 */
const RETENTION_MULTIPLIER: Record<CacheFamily, number> = {
  wordnik: 4,
  openrouter: 4,
  "npm-available": 12,
  "npm-taken": 7,
};

export function cachePolicyFor(family: CacheFamily, config: ServerConfig): CacheWritePolicy {
  const freshForMs = freshFor(family, config);
  return {
    freshForMs,
    retainForMs: freshForMs * RETENTION_MULTIPLIER[family],
  };
}

export function freshFor(family: CacheFamily, config: ServerConfig): number {
  switch (family) {
    case "wordnik":
      return config.cache.ttl.wordnikMs;
    case "openrouter":
      return config.cache.ttl.openrouterMs;
    case "npm-available":
      return config.cache.ttl.npmAvailableMs;
    case "npm-taken":
      return config.cache.ttl.npmTakenMs;
  }
}
