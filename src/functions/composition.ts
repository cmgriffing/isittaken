import type { Client } from "@libsql/client";
import { getDbClient } from "../db/client";
import { ensureMigrated } from "../db/migrate";
import { createCacheRepository } from "../db/repositories/cache-repository";
import { LibsqlSessionRepository } from "../db/repositories/session-repository";
import { LibsqlUserRepository } from "../db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../db/repositories/quota-repository";
import { createWordnikSource } from "../adapters/wordnik/source";
import { createOpenRouterProvider } from "../adapters/openrouter/provider";
import { createServerRegistryAdapter } from "../adapters/registries/server-adapter";
import { cachePolicyFor, retentionFor } from "../domain/cache-policy";
import { REGISTRY_LINEUP, registryById } from "../domain/registries";
import type { RegistryDescriptor } from "../domain/registries";
import type {
  CacheRepository,
  Clock,
  CandidateSource,
  CreativeProvider,
  IdGenerator,
  PackageRegistry,
  QuotaRepository,
  SessionRepository,
  UserRepository,
} from "../domain/ports";
import type { RegistryId } from "../domain/types";
import type { ServerConfig, ServerRegistryId } from "../config/server";
import { createRateLimiter, type RateLimiter } from "../lib/rate-limit";
import { logger } from "../lib/logger";

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

  // Server-venue adapters are thin descriptor-driven wrappers; the registry
  // lineup in `src/domain/registries` remains the single source of truth.
  const serverRegistries = new Map<RegistryId, PackageRegistry>();
  const registryRateLimiters = new Map<RegistryId, RateLimiter>();
  for (const descriptor of REGISTRY_LINEUP) {
    if (descriptor.venue !== "server") continue;
    const settings = config.registries[descriptor.id as ServerRegistryId];
    serverRegistries.set(
      descriptor.id,
      createServerRegistryAdapter({
        descriptor,
        origin: settings.origin,
        timeoutMs: settings.timeoutMs,
        clock,
        cache,
        cachePolicies: {
          available: {
            freshForMs: settings.availableTtlMs,
            retainForMs: retentionFor("registry-available", settings.availableTtlMs),
          },
          taken: {
            freshForMs: settings.takenTtlMs,
            retainForMs: retentionFor("registry-taken", settings.takenTtlMs),
          },
        },
        fetchImpl: overrides.fetchImpl,
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
