import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { registryById } from "../domain/registries";

/**
 * Server-only configuration. This module is loaded exclusively by server-side
 * code (Netlify Functions, adapters, repositories). It must never be imported
 * by client islands; ESLint enforces that boundary for `src/islands/**`.
 */

/** Registry ids that run their availability checks server-side. */
const SERVER_REGISTRY_IDS = ["npm", "pypi", "rubygems", "hex", "maven"] as const;

export type ServerRegistryId = (typeof SERVER_REGISTRY_IDS)[number];

/** Default upstream timeout shared by server-venue registry checks. */
const DEFAULT_REGISTRY_TIMEOUT_MS = 4_000;

/** Fallback per-IP rate limit when a descriptor declares none. */
const DEFAULT_REGISTRY_RATE_LIMIT_PER_MINUTE = 30;

/** Resolved, per-registry runtime settings (descriptor defaults + env). */
export interface RegistryRuntimeSettings {
  /** Upstream origin for the check endpoint (tests/ops may override). */
  origin: string;
  timeoutMs: number;
  rateLimitPerMinute: number;
  availableTtlMs: number;
  takenTtlMs: number;
}

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

/**
 * Per-registry environment overrides, e.g. `REGISTRY_NPM_TIMEOUT_MS`,
 * `REGISTRY_PYPI_RATE_LIMIT_PER_MINUTE`, `REGISTRY_HEX_AVAILABLE_TTL_MS`.
 * Defaults come from the registry descriptors; the shared timeout default
 * applies when a registry has no override.
 */
const registryEnvShape: Record<string, z.ZodTypeAny> = Object.fromEntries(
  SERVER_REGISTRY_IDS.flatMap((id) => {
    const descriptor = registryById(id);
    if (!descriptor) throw new Error(`No registry descriptor for id ${id}.`);
    const prefix = `REGISTRY_${id.toUpperCase()}_`;
    return [
      [`${prefix}ORIGIN`, urlWithDefault(descriptor.checkOrigin)],
      [`${prefix}TIMEOUT_MS`, int(DEFAULT_REGISTRY_TIMEOUT_MS)],
      [
        `${prefix}RATE_LIMIT_PER_MINUTE`,
        int(descriptor.rateLimitPerMinute ?? DEFAULT_REGISTRY_RATE_LIMIT_PER_MINUTE),
      ],
      [`${prefix}AVAILABLE_TTL_MS`, int(descriptor.cacheTtl.availableMs)],
      [`${prefix}TAKEN_TTL_MS`, int(descriptor.cacheTtl.takenMs)],
    ] as const;
  }),
);

const envSchema = z.object({
  ...registryEnvShape,
  NODE_ENV: z.string().optional(),

  DATABASE_URL: stringWithDefault("file:./local.db"),
  DATABASE_AUTH_TOKEN: optionalString,

  WORDNIK_API_KEY: optionalString,
  WORDNIK_BASE_URL: urlWithDefault("https://api.wordnik.com/v4"),
  WORDNIK_TIMEOUT_MS: int(4_000),

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
  CACHE_TTL_REGISTRY_AVAILABLE_MS: int(300_000),
  CACHE_TTL_REGISTRY_TAKEN_MS: int(86_400_000),

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
  registries: Record<ServerRegistryId, RegistryRuntimeSettings>;
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
      registryAvailableMs: number;
      registryTakenMs: number;
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

  const registries = Object.fromEntries(
    SERVER_REGISTRY_IDS.map((id) => {
      const descriptor = registryById(id);
      if (!descriptor) throw new Error(`No registry descriptor for id ${id}.`);
      const prefix = `REGISTRY_${id.toUpperCase()}_`;
      const env = parsed as unknown as Record<string, string | number | undefined>;
      const settings: RegistryRuntimeSettings = {
        origin: env[`${prefix}ORIGIN`] as string,
        timeoutMs: env[`${prefix}TIMEOUT_MS`] as number,
        rateLimitPerMinute: env[`${prefix}RATE_LIMIT_PER_MINUTE`] as number,
        availableTtlMs: env[`${prefix}AVAILABLE_TTL_MS`] as number,
        takenTtlMs: env[`${prefix}TAKEN_TTL_MS`] as number,
      };
      return [id, settings];
    }),
  ) as Record<ServerRegistryId, RegistryRuntimeSettings>;

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
    registries,
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
        registryAvailableMs: parsed.CACHE_TTL_REGISTRY_AVAILABLE_MS,
        registryTakenMs: parsed.CACHE_TTL_REGISTRY_TAKEN_MS,
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

let dotenvLoaded = false;

/**
 * Local-development convenience: load `.env` from the working directory into
 * the environment before validating configuration (the Netlify Vite plugin
 * only injects linked-site variables, not `.env`). Real environment
 * variables always win; the file is not present in deployed environments,
 * making this a no-op in production. Values are never logged.
 */
function ensureDotEnvLoaded(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const envPath = join(process.cwd(), ".env");
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2] as string;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      const key = match[1] as string;
      if (process.env[key] === undefined && value !== "") process.env[key] = value;
    }
  } catch {
    // Best effort only; configuration validation reports what's missing.
  }
}

/** Memoized accessor for server runtime code (Functions, adapters). */
export function getServerConfig(): ServerConfig {
  ensureDotEnvLoaded();
  cached ??= loadServerConfig();
  return cached;
}

/** Test helper: clears the memoized configuration. */
export function resetServerConfigCache(): void {
  cached = undefined;
}
