import type { Clock, CacheRepository, PackageRegistry } from "../../domain/ports";
import { NPM_DESCRIPTOR, normalizeNpmName } from "../../domain/registries";
import {
  createServerRegistryAdapter,
  type RegistryCachePolicies,
} from "../registries/server-adapter";

export { normalizeNpmName };

export interface NpmRegistryOptions {
  /** Fixed registry origin; callers cannot override it per request. */
  origin: string;
  timeoutMs: number;
  clock: Clock;
  cache?: CacheRepository;
  cachePolicies?: RegistryCachePolicies;
  fetchImpl?: typeof fetch;
}

/**
 * npm registry adapter: the shared server-adapter wrapper driven by the npm
 * descriptor. Classification is conservative (404 -> available, 2xx metadata
 * -> taken, ambiguity -> unknown); verdicts cache in the generic
 * registry-available / registry-taken families.
 */
export function createNpmRegistry(options: NpmRegistryOptions): PackageRegistry {
  return createServerRegistryAdapter({
    descriptor: NPM_DESCRIPTOR,
    origin: options.origin,
    timeoutMs: options.timeoutMs,
    clock: options.clock,
    cache: options.cache,
    cachePolicies: options.cachePolicies,
    fetchImpl: options.fetchImpl,
  });
}
