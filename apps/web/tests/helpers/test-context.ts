import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureMigrated } from "../../src/db/migrate";
import { createCacheRepository } from "../../src/db/repositories/cache-repository";
import { createWordnikSource } from "../../src/adapters/wordnik/source";
import { createCachedNpmRegistry } from "../../src/adapters/npm/cached-registry";
import { createOpenRouterProvider } from "../../src/adapters/openrouter/provider";
import { createServerVenueRegistry } from "../../src/functions/composition";
import { LibsqlSessionRepository } from "../../src/db/repositories/session-repository";
import { LibsqlUserRepository } from "../../src/db/repositories/user-repository";
import { LibsqlQuotaRepository } from "../../src/db/repositories/quota-repository";
import { createRateLimiter, type RateLimiter } from "../../src/lib/rate-limit";
import { cachePolicyFor } from "../../src/cache-policy";
import { type PackageRegistry, type RegistryId } from "@isittaken/core";
import { REGISTRY_LINEUP } from "../../src/domain/registries";
import type { AppContext } from "../../src/functions/composition";
import type {
  RegistryRuntimeSettings,
  ServerConfig,
  ServerRegistryId,
} from "../../src/config/server";
import { loadServerConfig } from "../../src/config/server";
import type { IdGenerator } from "../../src/ports";
import { APP_VERSION } from "../../src/app-info";

const REPO_URL = "https://github.com/cmgriffing/isittaken";

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
  // Server-venue adapters mirror the composition root's construction: the
  // transport-pure @isittaken/core adapters keyed by the registry lineup,
  // with npm riding through the web cache decorator until phase 3's
  // generic cache replaces it (task 3.4).
  const serverRegistries = new Map<RegistryId, PackageRegistry>();
  const registryRateLimiters = new Map<RegistryId, RateLimiter>();
  for (const descriptor of REGISTRY_LINEUP) {
    if (descriptor.venue !== "server") continue;
    const settings = config.registries[descriptor.id as ServerRegistryId];
    const registry = createServerVenueRegistry(descriptor.id, {
      origin: settings.origin,
      timeoutMs: settings.timeoutMs,
      clock,
      version: APP_VERSION,
      repoUrl: REPO_URL,
      fetchImpl: options.fetchImpl,
    });
    if (!registry) continue;
    serverRegistries.set(
      descriptor.id,
      descriptor.id === "npm"
        ? createCachedNpmRegistry({
            registry,
            cache,
            cachePolicies: {
              "npm-available": cachePolicyFor("npm-available", config),
              "npm-taken": cachePolicyFor("npm-taken", config),
            },
          })
        : registry,
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
