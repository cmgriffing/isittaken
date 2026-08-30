import type { Client } from "@libsql/client";
import { getDbClient } from "../db/client";
import { ensureMigrated } from "../db/migrate";
import { createCacheRepository } from "../db/repositories/cache-repository";
import { LibsqlSessionRepository } from "../db/repositories/session-repository";
import { LibsqlUserRepository } from "../db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../db/repositories/quota-repository";
import { createWordnikSource } from "../adapters/wordnik/source";
import { createNpmRegistry } from "../adapters/npm/registry";
import { createOpenRouterProvider } from "../adapters/openrouter/provider";
import { cachePolicyFor } from "../domain/cache-policy";
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
import type { ServerConfig } from "../config/server";
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
  npmRegistry: PackageRegistry;
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

  const npmRegistry = createNpmRegistry({
    origin: config.npm.registryOrigin,
    timeoutMs: config.npm.timeoutMs,
    clock,
    cache,
    cachePolicies: {
      "npm-available": cachePolicyFor("npm-available", config),
      "npm-taken": cachePolicyFor("npm-taken", config),
    },
    fetchImpl: overrides.fetchImpl,
  });

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
    npmRegistry,
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
