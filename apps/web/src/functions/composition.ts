import type { Client } from "@libsql/client";
import { getDbClient } from "../db/client";
import { ensureMigrated } from "../db/migrate";
import { createCacheRepository } from "../db/repositories/cache-repository";
import { LibsqlSessionRepository } from "../db/repositories/session-repository";
import { LibsqlUserRepository } from "../db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../db/repositories/quota-repository";
import { createWordnikSource } from "../adapters/wordnik/source";
import { createCachedNpmRegistry } from "../adapters/npm/cached-registry";
import { createOpenRouterProvider } from "../adapters/openrouter/provider";
import { cachePolicyFor } from "../cache-policy";
import {
  createHexRegistry,
  createMavenRegistry,
  createNpmRegistry,
  createPypiRegistry,
  createRubygemsRegistry,
  type CandidateSource,
  type Clock,
  type PackageRegistry,
  type RegistryId,
} from "@isittaken/core";
// TEMPORARY (phase 1 merge shim): registry descriptors live here until
// phase 2 task 2.1 moves the descriptor surface into @isittaken/core and
// phase 3 re-points these imports; see openspec change
// merge-main-unify-registries, tasks 2.1/3.1/3.3.
import { REGISTRY_LINEUP, registryById, type RegistryDescriptor } from "../domain/registries";
import type {
  CacheRepository,
  CreativeProvider,
  IdGenerator,
  QuotaRepository,
  SessionRepository,
  UserRepository,
} from "../ports";
import type { ServerConfig, ServerRegistryId } from "../config/server";
import { createRateLimiter, type RateLimiter } from "../lib/rate-limit";
import { logger } from "../lib/logger";
import { APP_VERSION } from "../app-info";

const REPO_URL = "https://github.com/cmgriffing/isittaken";

export interface AppContext {
  config: ServerConfig;
  db: Client;
  clock: Clock;
  ids: IdGenerator;
  cache: CacheRepository;
  sessions: SessionRepository;
  users: UserRepository;
  quotas: QuotaRepository;
  wordnikSource: CandidateSource;
  /** Server-venue registry adapters, keyed by registry id. */
  serverRegistries: ReadonlyMap<RegistryId, PackageRegistry>;
  /** Every supported registry descriptor (client metadata included). */
  registryDescriptors: readonly RegistryDescriptor[];
  /** Per-(ip, registry) check rate limiters, keyed by registry id. */
  registryRateLimiters: ReadonlyMap<RegistryId, RateLimiter>;
  openRouterProvider: CreativeProvider;
  searchRateLimiter: RateLimiter;
  creativeRateLimiter: RateLimiter;
}

let monotonic = 0;

export interface CompositionOverrides {
  /** Use an existing database client (tests, one-shot scripts). */
  db?: Client;
  /** Override upstream fetch for adapters (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Composition root for Netlify Functions. Builds every adapter and
 * repository from validated configuration; Functions receive `AppContext`
 * and never construct providers themselves.
 */
export function createAppContext(
  config: ServerConfig,
  overrides: CompositionOverrides = {},
): AppContext {
  const clock: Clock = {
    nowMs: () => {
      const t = Date.now();
      return t > monotonic ? (monotonic = t) : (monotonic += 1);
    },
  };
  const ids: IdGenerator = {
    newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  };

  const db = overrides.db ?? getDbClient(config);
  // Migrations are idempotent; a failure must not take the whole API down.
  void ensureMigrated(db, clock.nowMs()).catch((error: unknown) => {
    logger.warn("migration_check_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  const cache = createCacheRepository(db, clock);
  const users = new LibsqlUserRepository(db, ids);
  const sessions = new LibsqlSessionRepository(db);
  const quotas = new LibsqlQuotaRepository(db);

  const wordnikSource = createWordnikSource({
    apiKey: config.wordnik.apiKey,
    baseUrl: config.wordnik.baseUrl,
    timeoutMs: config.wordnik.timeoutMs,
    clock,
    cache,
    cachePolicy: cachePolicyFor("wordnik", config),
    fetchImpl: overrides.fetchImpl,
  });

  // Server-venue registry adapters are the transport-pure adapters from
  // @isittaken/core, keyed by the registry lineup (the single source of
  // truth). The npm venue keeps our cache decorator until the generic web
  // cache decorator replaces it in phase 3 (task 3.4, key gains the venue-id
  // prefix); the other server venues run uncached until then.
  const serverRegistries = new Map<RegistryId, PackageRegistry>();
  const registryRateLimiters = new Map<RegistryId, RateLimiter>();
  for (const descriptor of REGISTRY_LINEUP) {
    if (descriptor.venue !== "server") continue;
    const settings = config.registries[descriptor.id as ServerRegistryId];
    const coreRegistry = createServerVenueRegistry(descriptor.id, {
      origin: settings.origin,
      timeoutMs: settings.timeoutMs,
      clock,
      version: APP_VERSION,
      repoUrl: REPO_URL,
      fetchImpl: overrides.fetchImpl,
    });
    if (!coreRegistry) continue;
    const registry =
      descriptor.id === "npm"
        ? createCachedNpmRegistry({
            registry: coreRegistry,
            cache,
            cachePolicies: {
              "npm-available": cachePolicyFor("npm-available", config),
              "npm-taken": cachePolicyFor("npm-taken", config),
            },
          })
        : coreRegistry;
    serverRegistries.set(descriptor.id, registry);
    registryRateLimiters.set(
      descriptor.id,
      createRateLimiter({ limit: settings.rateLimitPerMinute, windowMs: 60_000 }),
    );
  }

  const openRouterProvider = createOpenRouterProvider({
    apiKey: config.openrouter.apiKey,
    baseUrl: config.openrouter.baseUrl,
    model: config.openrouter.model,
    promptVersion: config.openrouter.promptVersion,
    timeoutMs: config.openrouter.timeoutMs,
    maxCandidates: config.openrouter.maxCandidates,
    fetchImpl: overrides.fetchImpl,
  });

  return {
    config,
    db,
    clock,
    ids,
    cache,
    sessions,
    users,
    quotas,
    wordnikSource,
    serverRegistries,
    registryDescriptors: REGISTRY_LINEUP,
    registryRateLimiters,
    openRouterProvider,
    searchRateLimiter: createRateLimiter({
      limit: config.rateLimit.publicSearchPerMinute,
      windowMs: 60_000,
    }),
    creativeRateLimiter: createRateLimiter({
      limit: config.rateLimit.creativePerMinute,
      windowMs: 60_000,
    }),
  };
}

/** Resolve a registry descriptor by id (undefined when unsupported). */
export function registryDescriptor(id: string): RegistryDescriptor | undefined {
  return registryById(id);
}

/**
 * Build the transport-pure registry adapter for a server-venue registry id
 * from @isittaken/core. Returns undefined for ids with no core adapter
 * (the web lineup adds `go` in phase 3). Exported so test contexts mirror
 * the composition root's construction exactly. Maven splits its origin into
 * search (bare-word fuzzy) and metadata (qualified exact) endpoints.
 */
export function createServerVenueRegistry(
  id: RegistryId,
  options: {
    origin: string;
    timeoutMs: number;
    clock: Clock;
    version: string;
    repoUrl: string;
    fetchImpl?: typeof fetch;
  },
): PackageRegistry | undefined {
  switch (id) {
    case "npm":
      return createNpmRegistry(options);
    case "pypi":
      return createPypiRegistry(options);
    case "rubygems":
      return createRubygemsRegistry(options);
    case "hex":
      return createHexRegistry(options);
    case "maven":
      return createMavenRegistry({
        searchOrigin: options.origin,
        metadataOrigin: options.origin,
        timeoutMs: options.timeoutMs,
        clock: options.clock,
        version: options.version,
        repoUrl: options.repoUrl,
        fetchImpl: options.fetchImpl,
      });
    default:
      return undefined;
  }
}
