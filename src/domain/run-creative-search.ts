import type { CacheRepository, Clock, CreativeProvider, QuotaRepository } from "./ports";
import { normalizeAndDedupeCandidates } from "./normalize-candidates";
import type { ComposedCandidate } from "./types";
import type { SearchLimits } from "./validate-search-request";
import { normalizeCandidateValue } from "./normalize-candidates";
import { decodeVersionedValue, encodeVersionedValue } from "./cache-value";

export const CREATIVE_CACHE_VALUE_VERSION = 1;

export interface CreativeDeps {
  provider: CreativeProvider;
  quotas: QuotaRepository;
  clock: Clock;
  userId: string;
  limits: SearchLimits;
  quota: {
    userBurstPerMinute: number;
    userPeriodicPerDay: number;
    appDailyGenerations: number;
  };
  creative: {
    model: string;
    promptVersion: number;
    schemaVersion: number;
    maxCandidates: number;
  };
  cache?: CacheRepository;
  /** TTL policy for the `openrouter` family (from server configuration). */
  cachePolicy?: { freshForMs: number; retainForMs: number };
}

export type CreativeSearchResult =
  | {
      status: "ok";
      cached: boolean;
      seed: string;
      candidates: ComposedCandidate[];
      generatedAtMs: number;
      quota: { burstRemaining: number; periodicRemaining: number; resetsAtMs: number };
    }
  | {
      status: "quota_exhausted";
      scope: "burst" | "periodic" | "application";
      resetsAtMs: number;
      message: string;
    }
  | {
      status: "generation_failed";
      reason: string;
      quota: { burstRemaining: number; periodicRemaining: number; resetsAtMs: number };
    };

export function creativeCacheKey(
  seed: string,
  deps: Pick<CreativeDeps, "creative">,
  regenerate: boolean,
): string {
  return (
    `v${deps.creative.schemaVersion}:model:${deps.creative.model}` +
    `:prompt${deps.creative.promptVersion}:seed:${normalizeCandidateValue(seed)}` +
    (regenerate ? ":regen" : "")
  );
}

/**
 * Creative generation pipeline. Authentication is enforced by the caller
 * (HTTP session middleware) *before* this use case runs, so cache access
 * stays behind login. On a cache-miss generation, burst, periodic, and
 * application-wide quotas are reserved atomically before the provider call;
 * selected upstream failures refund the longer-period quota while the burst
 * attempt is still accounted for.
 */
export async function runCreativeSearch(
  input: { seed: string; regenerate: boolean },
  deps: CreativeDeps,
): Promise<CreativeSearchResult> {
  const nowMs = deps.clock.nowMs();
  const cacheKey = creativeCacheKey(input.seed, deps, input.regenerate);

  if (!input.regenerate && deps.cache) {
    try {
      const cached = await deps.cache.read("openrouter", cacheKey);
      if (cached.status === "fresh") {
        const data = decodeVersionedValue<{ candidates: string[] }>(
          cached.valueJson,
          CREATIVE_CACHE_VALUE_VERSION,
        );
        if (data && Array.isArray(data.candidates) && data.candidates.length > 0) {
          return {
            status: "ok",
            cached: true,
            seed: input.seed,
            candidates: composeCandidates(data.candidates, deps),
            generatedAtMs: nowMs,
            quota: await quotaSnapshot(deps, nowMs),
          };
        }
      }
    } catch {
      // Cache failure degrades to a generation attempt.
    }
  }

  const userSubject = { subjectType: "user" as const, subjectId: deps.userId };
  const appSubject = { subjectType: "application" as const, subjectId: "global" };
  const burstPeriod = Math.floor(nowMs / 60_000) * 60_000;
  const dayPeriod = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const burstResetsAtMs = burstPeriod + 60_000;
  const dayResetsAtMs = dayPeriod + 86_400_000;

  // Reserve burst -> periodic -> application. Each failure refunds what the
  // previous reservations granted.
  const burst = await deps.quotas.reserve(
    userSubject,
    "burst-minute",
    burstPeriod,
    deps.quota.userBurstPerMinute,
    1,
  );
  if (!burst.granted) {
    return {
      status: "quota_exhausted",
      scope: "burst",
      resetsAtMs: burstResetsAtMs,
      message: "Too many generation attempts right now.",
    };
  }

  const periodic = await deps.quotas.reserve(
    userSubject,
    "periodic-day",
    dayPeriod,
    deps.quota.userPeriodicPerDay,
    1,
  );
  if (!periodic.granted) {
    await deps.quotas.refund(userSubject, "burst-minute", burstPeriod, 1);
    return {
      status: "quota_exhausted",
      scope: "periodic",
      resetsAtMs: dayResetsAtMs,
      message: "Daily generation quota exhausted.",
    };
  }

  const app = await deps.quotas.reserve(
    appSubject,
    "periodic-day",
    dayPeriod,
    deps.quota.appDailyGenerations,
    1,
  );
  if (!app.granted) {
    await deps.quotas.refund(userSubject, "periodic-day", dayPeriod, 1);
    await deps.quotas.refund(userSubject, "burst-minute", burstPeriod, 1);
    return {
      status: "quota_exhausted",
      scope: "application",
      resetsAtMs: dayResetsAtMs,
      message: "The application-wide generation ceiling is exhausted.",
    };
  }

  const generation = await deps.provider.generate(input.seed, deps.creative.maxCandidates);

  if (generation.status === "failed") {
    if (generation.refundable) {
      // Refund longer-period quotas; the burst attempt is still counted.
      await deps.quotas.refund(userSubject, "periodic-day", dayPeriod, 1);
      await deps.quotas.refund(appSubject, "periodic-day", dayPeriod, 1);
    }
    return {
      status: "generation_failed",
      reason: generation.reason,
      quota: await quotaSnapshot(deps, nowMs),
    };
  }

  await deps.quotas.settle(userSubject, "periodic-day", dayPeriod, {
    promptTokens: generation.usage?.promptTokens ?? 0,
    completionTokens: generation.usage?.completionTokens ?? 0,
  });

  if (deps.cache && deps.cachePolicy) {
    try {
      await deps.cache.write(
        "openrouter",
        // Regeneration results are also reusable; only the lookup bypassed.
        creativeCacheKey(input.seed, deps, false),
        encodeVersionedValue(CREATIVE_CACHE_VALUE_VERSION, { candidates: generation.candidates }),
        deps.cachePolicy,
      );
    } catch {
      // Cache write failure never fails generation.
    }
  }

  return {
    status: "ok",
    cached: false,
    seed: input.seed,
    candidates: composeCandidates(generation.candidates, deps),
    generatedAtMs: deps.clock.nowMs(),
    quota: await quotaSnapshot(deps, nowMs),
  };
}

async function quotaSnapshot(
  deps: Pick<CreativeDeps, "quotas" | "userId" | "quota">,
  nowMs: number,
): Promise<{ burstRemaining: number; periodicRemaining: number; resetsAtMs: number }> {
  const burstPeriod = Math.floor(nowMs / 60_000) * 60_000;
  const dayPeriod = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const subject = { subjectType: "user" as const, subjectId: deps.userId };
  const [burst, periodic] = await Promise.all([
    deps.quotas.read(subject, "burst-minute", burstPeriod),
    deps.quotas.read(subject, "periodic-day", dayPeriod),
  ]);
  return {
    burstRemaining: Math.max(0, deps.quota.userBurstPerMinute - burst.used),
    periodicRemaining: Math.max(0, deps.quota.userPeriodicPerDay - periodic.used),
    resetsAtMs: burstPeriod + 60_000,
  };
}

/** Normalize, validate, and dedupe generated names into candidates. */
function composeCandidates(
  rawNames: readonly string[],
  deps: Pick<CreativeDeps, "limits">,
): ComposedCandidate[] {
  const raw = rawNames.map((value) => ({ value, provenance: "openrouter" as const }));
  const candidates = normalizeAndDedupeCandidates(raw, { limits: deps.limits });
  // Registry results are absent at generation time; the client fans out
  // availability checks per registry.
  return candidates.map((candidate) => ({
    name: candidate.normalized,
    provenance: candidate.provenance,
    registryResults: [],
  }));
}
