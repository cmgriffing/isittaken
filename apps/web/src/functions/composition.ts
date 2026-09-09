import type { Client } from "@libsql/client";
import { getDbClient } from "../db/client";
import { ensureMigrated } from "../db/migrate";
import { createCacheRepository } from "../db/repositories/cache-repository";
import { LibsqlSessionRepository } from "../db/repositories/session-repository";
import { LibsqlUserRepository } from "../db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../db/repositories/quota-repository";
import { createWordnikSource } from "../adapters/wordnik/source";
import { createCachedRegistry } from "../adapters/registries/cached-registry";
import { createOpenRouterProvider } from "../adapters/openrouter/provider";
import { cachePolicyFor } from "../cache-policy";
import {
  createGoRegistry,
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
import { REGISTRY_LINEUP, registryById, type RegistryDescriptor } from "@isittaken/core";
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
  // truth). Every server venue rides the generic web cache decorator
  // (decision D5: caching is a web concern; core stays cache-free). The
  // per-verdict TTLs come from the generic registry-* cache policy, which
  // mirrors the venue descriptors' cacheTtl (5 min available / 24 h taken).
  const serverRegistries = new Map<RegistryId, PackageRegistry>();
  const registryRateLimiters = new Map<RegistryId, RateLimiter>();
  for (const descriptor of REGISTRY_LINEUP) {
    if (descriptor.venue !== "server") continue;
    const settings = config.registries[descriptor.id as ServerRegistryId];
    const coreRegistry = createServerVenueRegistry(descriptor.id, {
      origin: settings.origin,
      proxyOrigin: settings.proxyOrigin,
      timeoutMs: settings.timeoutMs,
      clock,
      version: APP_VERSION,
      repoUrl: REPO_URL,
      fetchImpl: overrides.fetchImpl,
    });
    if (!coreRegistry) continue;
    serverRegistries.set(
      descriptor.id,
      createCachedRegistry({
        registry: coreRegistry,
        cache,
        cachePolicies: {
          available: cachePolicyFor("registry-available", config),
          taken: cachePolicyFor("registry-taken", config),
        },
      }),
    );
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
 * from @isittaken/core. Returns undefined for ids with no core adapter.
 * Exported so test contexts mirror the composition root's construction
 * exactly. Maven splits its origin into search (bare-word fuzzy) and
 * metadata (qualified exact) endpoints; go splits into search (pkg.go.dev)
 * and module-proxy (qualified exact) endpoints.
 */
export function createServerVenueRegistry(
  id: RegistryId,
  options: {
    origin: string;
    proxyOrigin?: string;
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
    case "go":
      return createGoRegistry({
        searchOrigin: options.origin,
        proxyOrigin: options.proxyOrigin ?? "https://proxy.golang.org",
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
