import { z } from "zod";

/**
 * Server-only configuration. This module is loaded exclusively by server-side
 * code (Netlify Functions, adapters, repositories). It must never be imported
 * by client islands; ESLint enforces that boundary for `src/islands/**`.
 */

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyStringToUndefined, z.string().optional());

const int = (fallback: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).default(fallback),
  );

const stringWithDefault = (fallback: string) =>
  z.preprocess(emptyStringToUndefined, z.string().default(fallback));

const urlWithDefault = (fallback: string) =>
  z.preprocess(emptyStringToUndefined, z.string().url().default(fallback));

const flag = z.preprocess(emptyStringToUndefined, z.coerce.boolean().optional());

const envSchema = z.object({
  NODE_ENV: z.string().optional(),

  DATABASE_URL: stringWithDefault("file:./local.db"),
  DATABASE_AUTH_TOKEN: optionalString,

  WORDNIK_API_KEY: optionalString,
  WORDNIK_BASE_URL: urlWithDefault("https://api.wordnik.com/v4"),
  WORDNIK_TIMEOUT_MS: int(4_000),

  NPM_REGISTRY_ORIGIN: stringWithDefault("https://registry.npmjs.org"),
  NPM_TIMEOUT_MS: int(4_000),
  NPM_CONCURRENCY: int(8),

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_TIMEOUT_MS: int(6_000),

  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: urlWithDefault("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL: stringWithDefault("openai/gpt-4o-mini"),
  OPENROUTER_PROMPT_VERSION: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().min(1).default(1),
  ),
  OPENROUTER_SCHEMA_VERSION: z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().min(1).default(1),
  ),
  OPENROUTER_TIMEOUT_MS: int(25_000),
  OPENROUTER_MAX_CANDIDATES: int(12),

  CACHE_TTL_WORDNIK_MS: int(604_800_000),
  CACHE_TTL_OPENROUTER_MS: int(259_200_000),
  CACHE_TTL_NPM_AVAILABLE_MS: int(300_000),
  CACHE_TTL_NPM_TAKEN_MS: int(86_400_000),

  QUOTA_USER_BURST_PER_MINUTE: int(5),
  QUOTA_USER_PERIODIC_PER_DAY: int(25),
  QUOTA_APP_DAILY_GENERATIONS: int(1_000),

  RATE_LIMIT_PUBLIC_SEARCH_PER_MINUTE: int(30),
  RATE_LIMIT_CREATIVE_PER_MINUTE: int(10),

  LIMIT_MAX_SEED_LENGTH: int(64),
  LIMIT_MAX_INJECTED_SYNONYMS: int(25),
  LIMIT_MAX_INJECTED_CREATIVES: int(25),
  LIMIT_MAX_CANDIDATE_LENGTH: int(214),
  LIMIT_MAX_TOTAL_CANDIDATES: int(120),

  SESSION_COOKIE_NAME: stringWithDefault("iit_session"),
  SESSION_COOKIE_SECURE: flag,
  SESSION_TTL_MS: int(604_800_000),
  SESSION_OAUTH_COOKIE_TTL_MS: int(600_000),

  PUBLIC_SITE_URL: urlWithDefault("http://localhost:4321"),

  ALLOW_LOCAL_DB_IN_PRODUCTION: flag,
});

export type ServerConfig = {
  app: {
    publicSiteUrl: string;
    isProduction: boolean;
  };
  database: {
    url: string;
    authToken?: string;
  };
  wordnik: {
    apiKey?: string;
    baseUrl: string;
    timeoutMs: number;
  };
  npm: {
    registryOrigin: string;
    timeoutMs: number;
    concurrency: number;
  };
  github: {
    clientId?: string;
    clientSecret?: string;
    timeoutMs: number;
  };
  openrouter: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    promptVersion: number;
    schemaVersion: number;
    timeoutMs: number;
    maxCandidates: number;
  };
  cache: {
    ttl: {
      wordnikMs: number;
      openrouterMs: number;
      npmAvailableMs: number;
      npmTakenMs: number;
    };
  };
  quota: {
    userBurstPerMinute: number;
    userPeriodicPerDay: number;
    appDailyGenerations: number;
  };
  rateLimit: {
    publicSearchPerMinute: number;
    creativePerMinute: number;
  };
  limits: {
    maxSeedLength: number;
    maxInjectedSynonyms: number;
    maxInjectedCreatives: number;
    maxCandidateLength: number;
    maxTotalCandidates: number;
  };
  session: {
    cookieName: string;
    cookieSecure: boolean;
    ttlMs: number;
    oauthCookieTtlMs: number;
  };
};

let cached: ServerConfig | undefined;

/**
 * Build a validated configuration from an environment record. Throws a
 * descriptive error when a value is invalid. Pure: it never reads
 * `process.env` implicitly beyond the default parameter.
 */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ServerConfig {
  const parsed = envSchema.parse(env);
  const isProduction = parsed.NODE_ENV === "production";
  const cookieSecure = parsed.SESSION_COOKIE_SECURE ?? isProduction;

  if (
    isProduction &&
    parsed.DATABASE_URL.startsWith("file:") &&
    !parsed.ALLOW_LOCAL_DB_IN_PRODUCTION
  ) {
    throw new Error(
      "Production configuration must point DATABASE_URL at a Turso database (libsql://...). " +
        "Set ALLOW_LOCAL_DB_IN_PRODUCTION=true only for throwaway previews.",
    );
  }

  if (isProduction && !cookieSecure) {
    throw new Error(
      "SESSION_COOKIE_SECURE=false is not allowed in production sessions over HTTPS.",
    );
  }

  return {
    app: {
      publicSiteUrl: parsed.PUBLIC_SITE_URL,
      isProduction,
    },
    database: {
      url: parsed.DATABASE_URL,
      authToken: parsed.DATABASE_AUTH_TOKEN,
    },
    wordnik: {
      apiKey: parsed.WORDNIK_API_KEY,
      baseUrl: parsed.WORDNIK_BASE_URL,
      timeoutMs: parsed.WORDNIK_TIMEOUT_MS,
    },
    npm: {
      registryOrigin: parsed.NPM_REGISTRY_ORIGIN,
      timeoutMs: parsed.NPM_TIMEOUT_MS,
      concurrency: parsed.NPM_CONCURRENCY,
    },
    github: {
      clientId: parsed.GITHUB_CLIENT_ID,
      clientSecret: parsed.GITHUB_CLIENT_SECRET,
      timeoutMs: parsed.GITHUB_TIMEOUT_MS,
    },
    openrouter: {
      apiKey: parsed.OPENROUTER_API_KEY,
      baseUrl: parsed.OPENROUTER_BASE_URL,
      model: parsed.OPENROUTER_MODEL,
      promptVersion: parsed.OPENROUTER_PROMPT_VERSION,
      schemaVersion: parsed.OPENROUTER_SCHEMA_VERSION,
      timeoutMs: parsed.OPENROUTER_TIMEOUT_MS,
      maxCandidates: parsed.OPENROUTER_MAX_CANDIDATES,
    },
    cache: {
      ttl: {
        wordnikMs: parsed.CACHE_TTL_WORDNIK_MS,
        openrouterMs: parsed.CACHE_TTL_OPENROUTER_MS,
        npmAvailableMs: parsed.CACHE_TTL_NPM_AVAILABLE_MS,
        npmTakenMs: parsed.CACHE_TTL_NPM_TAKEN_MS,
      },
    },
    quota: {
      userBurstPerMinute: parsed.QUOTA_USER_BURST_PER_MINUTE,
      userPeriodicPerDay: parsed.QUOTA_USER_PERIODIC_PER_DAY,
      appDailyGenerations: parsed.QUOTA_APP_DAILY_GENERATIONS,
    },
    rateLimit: {
      publicSearchPerMinute: parsed.RATE_LIMIT_PUBLIC_SEARCH_PER_MINUTE,
      creativePerMinute: parsed.RATE_LIMIT_CREATIVE_PER_MINUTE,
    },
    limits: {
      maxSeedLength: parsed.LIMIT_MAX_SEED_LENGTH,
      maxInjectedSynonyms: parsed.LIMIT_MAX_INJECTED_SYNONYMS,
      maxInjectedCreatives: parsed.LIMIT_MAX_INJECTED_CREATIVES,
      maxCandidateLength: parsed.LIMIT_MAX_CANDIDATE_LENGTH,
      maxTotalCandidates: parsed.LIMIT_MAX_TOTAL_CANDIDATES,
    },
    session: {
      cookieName: parsed.SESSION_COOKIE_NAME,
      cookieSecure,
      ttlMs: parsed.SESSION_TTL_MS,
      oauthCookieTtlMs: parsed.SESSION_OAUTH_COOKIE_TTL_MS,
    },
  };
}

/** Memoized accessor for server runtime code (Functions, adapters). */
export function getServerConfig(): ServerConfig {
  cached ??= loadServerConfig();
  return cached;
}

/** Test helper: clears the memoized configuration. */
export function resetServerConfigCache(): void {
  cached = undefined;
}
