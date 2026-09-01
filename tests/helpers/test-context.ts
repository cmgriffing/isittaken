import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureMigrated } from "../../src/db/migrate";
import { createCacheRepository } from "../../src/db/repositories/cache-repository";
import { createWordnikSource } from "../../src/adapters/wordnik/source";
import { createOpenRouterProvider } from "../../src/adapters/openrouter/provider";
import { createServerRegistryAdapter } from "../../src/adapters/registries/server-adapter";
import { LibsqlSessionRepository } from "../../src/db/repositories/session-repository";
import { LibsqlUserRepository } from "../../src/db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../../src/db/repositories/quota-repository";
import { createRateLimiter, type RateLimiter } from "../../src/lib/rate-limit";
import { cachePolicyFor, retentionFor } from "../../src/domain/cache-policy";
import { REGISTRY_LINEUP } from "../../src/domain/registries";
import type { AppContext } from "../../src/functions/composition";
import type {
  RegistryRuntimeSettings,
  ServerConfig,
  ServerRegistryId,
} from "../../src/config/server";
import { loadServerConfig } from "../../src/config/server";
import type { IdGenerator } from "../../src/domain/ports";

export interface TestContextOptions {
  /** Fake upstream fetch shared by all adapters. */
  fetchImpl?: typeof fetch;
  config?: Partial<ServerConfig>;
  /** Per-registry settings overrides, merged over descriptor defaults. */
  registrySettings?: Partial<Record<ServerRegistryId, Partial<RegistryRuntimeSettings>>>;
  github?: { clientId: string; clientSecret: string };
  session?: Partial<ServerConfig["session"]>;
  publicSiteUrl?: string;
  rateLimits?: { searchPerMinute?: number; creativePerMinute?: number };
}

let dbCounter = 0;

export async function createTestContext(
  options: TestContextOptions = {},
): Promise<{ ctx: AppContext; db: Client; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `isittaken-api-${(dbCounter += 1)}-`));
  const db = createClient({ url: `file:${join(dir, "test.db")}` });
  await ensureMigrated(db);

  const base = loadServerConfig({
    DATABASE_URL: `file:${join(dir, "test.db")}`,
    WORDNIK_API_KEY: "test-wordnik-key",
    LOG_LEVEL: "error",
  });
  const config: ServerConfig = {
    ...base,
    ...options.config,
    registries: {
      ...base.registries,
      ...Object.fromEntries(
        Object.entries(options.registrySettings ?? {}).map(([id, override]) => [
          id,
          {
            ...base.registries[id as ServerRegistryId],
            ...override,
          } as RegistryRuntimeSettings,
        ]),
      ),
    } as ServerConfig["registries"],
    github: { ...base.github, ...options.github },
    session: { ...base.session, ...options.session },
    app: { ...base.app, publicSiteUrl: options.publicSiteUrl ?? base.app.publicSiteUrl },
  };

  let tick = 0;
  const clock = {
    nowMs: () => {
      const t = Date.now();
      return t > tick ? (tick = t) : (tick += 1);
    },
  };
  const ids: IdGenerator = {
    newId: () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  const cache = createCacheRepository(db, clock);
  const wordnikSource = createWordnikSource({
    apiKey: config.wordnik.apiKey,
    baseUrl: config.wordnik.baseUrl,
    timeoutMs: config.wordnik.timeoutMs,
    clock,
    cache,
    cachePolicy: cachePolicyFor("wordnik", config),
    fetchImpl: options.fetchImpl,
  });

  // Server-venue adapters mirror the composition root's construction.
  const serverRegistries = new Map<string, ReturnType<typeof createServerRegistryAdapter>>();
  const registryRateLimiters = new Map<string, RateLimiter>();
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
        fetchImpl: options.fetchImpl,
      }),
    );
    registryRateLimiters.set(
      descriptor.id,
      createRateLimiter({ limit: settings.rateLimitPerMinute, windowMs: 60_000 }),
    );
  }

  const openRouterProvider = createOpenRouterProvider({
    apiKey: config.openrouter.apiKey ?? "test-openrouter-key",
    baseUrl: config.openrouter.baseUrl,
    model: config.openrouter.model,
    promptVersion: config.openrouter.promptVersion,
    timeoutMs: config.openrouter.timeoutMs,
    maxCandidates: config.openrouter.maxCandidates,
    fetchImpl: options.fetchImpl,
  });

  const ctx: AppContext = {
    config,
    db,
    clock,
    ids,
    cache,
    sessions: new LibsqlSessionRepository(db),
    users: new LibsqlUserRepository(db, ids),
    quotas: new LibsqlQuotaRepository(db),
    wordnikSource,
    serverRegistries,
    registryDescriptors: REGISTRY_LINEUP,
    registryRateLimiters,
    openRouterProvider,
    searchRateLimiter: createRateLimiter({
      limit: options.rateLimits?.searchPerMinute ?? config.rateLimit.publicSearchPerMinute,
      windowMs: 60_000,
    }),
    creativeRateLimiter: createRateLimiter({
      limit: options.rateLimits?.creativePerMinute ?? config.rateLimit.creativePerMinute,
      windowMs: 60_000,
    }),
  };

  return {
    ctx,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type { RateLimiter };
