import type { RegistryDescriptor } from "../../domain/registries";
import { normalizerFor } from "../../domain/registries";
import type { RegistryId, RegistryStatus } from "../../domain/types";
import { VerdictCache } from "./verdict-cache";

/**
 * Client availability orchestration. After candidate discovery, the client
 * fans out availability checks per (candidate, registry):
 *   server-venue registries -> POST /api/check
 *   browser-venue registries -> direct fetch to the registry's public endpoint
 *
 * Checks dedupe per registry-normalized name, run under a bounded
 * concurrency cap, reschedule after 429 `retry-after` responses (bounded
 * retries), and flow through the stale-while-revalidate verdict cache.
 */

export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_MAX_RETRIES = 2;

/** A rendered per-(candidate, registry) cell state. */
export interface VerdictCell {
  registry: RegistryId;
  /** Candidate name this verdict applies to. */
  candidateName: string;
  /** Registry-normalized name that was (or would be) checked. */
  checkedName: string;
  status: RegistryStatus;
  checkedAtMs?: number;
  reason?: string;
  /** True while the painted verdict came from a stale cache entry. */
  cached?: boolean;
}

export interface CheckOutcome {
  status: RegistryStatus;
  checkedAtMs: number;
  reason?: string;
  /** Retryable rate limit: reschedule after `retryAfterSeconds`. */
  rateLimited?: { retryAfterSeconds: number };
}

export interface AvailabilityServiceOptions {
  /** Registries to check (the user's selection). */
  registries: readonly RegistryDescriptor[];
  onResult: (cell: VerdictCell) => void;
  concurrency?: number;
  maxRetries?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
  fetchImpl?: typeof fetch;
  cache?: VerdictCache;
}

interface CheckTarget {
  descriptor: RegistryDescriptor;
  name: string;
}

function parseRetryAfter(headerValue: string | null): number {
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
}

/** POST /api/check for a server-venue registry. */
async function checkViaApi(
  word: string,
  registryId: string,
  fetchImpl: typeof fetch,
): Promise<CheckOutcome> {
  try {
    const response = await fetchImpl("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ word, registry: registryId }),
    });
    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: Date.now(),
        rateLimited: {
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        },
      };
    }
    if (!response.ok) {
      return {
        status: "unknown",
        checkedAtMs: Date.now(),
        reason: `Check request failed with status ${response.status}.`,
      };
    }
    const body = (await response.json()) as {
      status: RegistryStatus;
      checkedAtMs: number;
      reason?: string;
    };
    return {
      status: body.status,
      checkedAtMs: body.checkedAtMs,
      ...(body.reason ? { reason: body.reason } : {}),
    };
  } catch {
    return {
      status: "unknown",
      checkedAtMs: Date.now(),
      reason: "Check request failed.",
    };
  }
}

/** Direct browser fetch against a browser-venue registry's public endpoint. */
async function checkViaBrowser(
  descriptor: RegistryDescriptor,
  name: string,
  fetchImpl: typeof fetch,
): Promise<CheckOutcome> {
  try {
    const response = await fetchImpl(descriptor.checkUrl(name), {
      headers: { accept: "application/json" },
    });
    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: Date.now(),
        rateLimited: {
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        },
      };
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    const classification = descriptor.classify({ name, status: response.status, json, text });
    return {
      status: classification.status,
      checkedAtMs: Date.now(),
      ...(classification.reason ? { reason: classification.reason } : {}),
    };
  } catch {
    return {
      status: "unknown",
      checkedAtMs: Date.now(),
      reason: `${descriptor.label} request failed.`,
    };
  }
}

/**
 * Create the availability service. `onResult` fires for every cell state
 * transition: invalid classification, cached stale paint, and final verdicts.
 */
export function createAvailabilityService(options: AvailabilityServiceOptions) {
  const {
    registries,
    onResult,
    concurrency = DEFAULT_CONCURRENCY,
    maxRetries = DEFAULT_MAX_RETRIES,
    now = () => Date.now(),
    schedule = (fn, delayMs) => setTimeout(fn, delayMs),
    fetchImpl = fetch,
    cache = new VerdictCache({
      ttlFor: (registryId, status) => {
        const descriptor = registries.find((d) => d.id === registryId);
        if (!descriptor) return 0;
        return status === "available"
          ? descriptor.cacheTtl.availableMs
          : descriptor.cacheTtl.takenMs;
      },
    }),
  } = options;

  // Shared, bounded queue across all registries and batches: no more than
  // `concurrency` checks are in flight at any moment.
  const queue: { task: () => Promise<void>; done: () => void }[] = [];
  let running = 0;

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      running += 1;
      item
        .task()
        .catch(() => {
          // Individual check failures never poison other results.
        })
        .finally(() => {
          running -= 1;
          item.done();
          pump();
        });
    }
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      queue.push({ task, done: resolve });
      pump();
    });
  }

  // In-flight dedupe: identical (registry, normalized name) checks share one
  // network round-trip per session.
  const inFlight = new Map<string, Promise<CheckOutcome>>();

  function outcomeFor(target: CheckTarget, attempt: number): Promise<CheckOutcome> {
    const key = `${target.descriptor.id}:${target.name}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const request =
      target.descriptor.venue === "server"
        ? checkViaApi(target.name, target.descriptor.id, fetchImpl)
        : checkViaBrowser(target.descriptor, target.name, fetchImpl);

    const settled = request.then((outcome) => {
      inFlight.delete(key);
      if (outcome.rateLimited && attempt < maxRetries) {
        const retryAfter = outcome.rateLimited.retryAfterSeconds;
        return new Promise<CheckOutcome>((resolve) => {
          schedule(() => resolve(outcomeFor(target, attempt + 1)), retryAfter * 1_000);
        });
      }
      if (outcome.rateLimited) {
        return {
          status: "unknown" as const,
          checkedAtMs: outcome.checkedAtMs,
          reason: `${target.descriptor.label} rate limited; retries exhausted.`,
        };
      }
      return outcome;
    });
    inFlight.set(key, settled);
    return settled;
  }

  function emitCell(
    candidateName: string,
    descriptor: RegistryDescriptor,
    checkedName: string,
    outcome: CheckOutcome,
    cached: boolean,
  ): void {
    onResult({
      registry: descriptor.id,
      candidateName,
      checkedName,
      status: outcome.status,
      checkedAtMs: outcome.checkedAtMs,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      cached,
    });
  }

  function persistVerdict(
    descriptor: RegistryDescriptor,
    name: string,
    outcome: CheckOutcome,
  ): void {
    if (outcome.status !== "available" && outcome.status !== "taken") return;
    cache.write(descriptor.id, name, outcome.status, outcome.checkedAtMs, now());
  }

  /**
   * Check every candidate against every selected registry. Idempotent:
   * cached-fresh verdicts emit immediately, cached-stale verdicts paint
   * with a "cached" hint and revalidate, and everything else goes to the
   * network under the shared concurrency cap.
   */
  async function checkCandidates(candidates: readonly { name: string }[]): Promise<void> {
    const tasks: (() => Promise<void>)[] = [];

    for (const descriptor of registries) {
      const normalize = normalizerFor(descriptor);

      // Dedupe registry-normalized names within this batch; one check per
      // normalized name, verdicts applied to every matching candidate.
      const byCheckedName = new Map<string, string[]>();
      for (const candidate of candidates) {
        const validation = normalize(candidate.name);
        const checkedName = validation.ok ? validation.name : candidate.name;
        const group = byCheckedName.get(checkedName);
        if (group) group.push(candidate.name);
        else byCheckedName.set(checkedName, [candidate.name]);
      }

      for (const [checkedName, candidateNames] of byCheckedName) {
        const validation = normalize(checkedName);
        if (!validation.ok) {
          // Locally invalid: classified without any network request.
          for (const candidateName of candidateNames) {
            onResult({
              registry: descriptor.id,
              candidateName,
              checkedName,
              status: "invalid",
              checkedAtMs: now(),
              reason: validation.reason,
            });
          }
          continue;
        }

        const cached = cache.read(descriptor.id, checkedName, now());
        if (cached?.status === "fresh") {
          for (const candidateName of candidateNames) {
            emitCell(
              candidateName,
              descriptor,
              checkedName,
              {
                status: cached.verdict.status,
                checkedAtMs: cached.verdict.checkedAtMs,
              },
              false,
            );
          }
          continue;
        }

        tasks.push(async () => {
          const outcome = await outcomeFor({ descriptor, name: checkedName }, 0);
          persistVerdict(descriptor, checkedName, outcome);
          for (const candidateName of candidateNames) {
            emitCell(candidateName, descriptor, checkedName, outcome, false);
          }
        });

        // Stale-while-revalidate: paint the retained verdict now, labeled.
        if (cached?.status === "stale") {
          for (const candidateName of candidateNames) {
            emitCell(
              candidateName,
              descriptor,
              checkedName,
              {
                status: cached.verdict.status,
                checkedAtMs: cached.verdict.checkedAtMs,
              },
              true,
            );
          }
        }
      }
    }

    // Run the queued checks under the shared concurrency cap.
    await Promise.all(tasks.map(enqueue));
  }

  return { checkCandidates };
}

export type AvailabilityService = ReturnType<typeof createAvailabilityService>;
