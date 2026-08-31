import type { CandidateSource, RawCandidate } from "./ports";
import { normalizeAndDedupeCandidates } from "./normalize-candidates";
import type { SearchResponse, SourceOutcome } from "./types";
import type { SearchLimits } from "./validate-search-request";

/** Structural input for discovery; `ValidatedSearchRequest` satisfies it. */
export interface DiscoveryInput {
  seed: string;
  injectedSynonyms?: readonly string[];
  injectedCreatives?: readonly string[];
}

export interface DiscoveryDeps {
  sources: readonly CandidateSource[];
  clock: { nowMs(): number };
  limits: SearchLimits;
}

/**
 * Candidate-discovery pipeline:
 *   collect source candidates -> normalize/dedupe -> compose the response.
 *
 * Registry availability is intentionally out of scope: the client fans out
 * per-registry checks against `POST /api/check` and browser-venue endpoints
 * (see `client-availability`). Sources fail independently; a failed source
 * never blocks other candidates.
 */
export async function runDiscovery(
  validated: DiscoveryInput,
  deps: DiscoveryDeps,
): Promise<SearchResponse> {
  const sourceOutcomes: SourceOutcome[] = [];
  const rawCandidates: RawCandidate[] = [{ value: validated.seed, provenance: "input" }];

  for (const source of deps.sources) {
    let outcome: SourceOutcome;
    try {
      const result = await source.fetch(validated.seed);
      if (result.status === "ok") {
        rawCandidates.push(...result.candidates);
        outcome = { source: source.id, status: "ok" };
      } else {
        outcome = { source: source.id, status: "unavailable", reason: result.reason };
      }
    } catch (error) {
      outcome = {
        source: source.id,
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Unknown source failure.",
      };
    }
    sourceOutcomes.push(outcome);
  }

  for (const value of validated.injectedSynonyms ?? []) {
    rawCandidates.push({ value, provenance: "injected-synonym" });
  }
  for (const value of validated.injectedCreatives ?? []) {
    rawCandidates.push({ value, provenance: "injected-creative" });
  }

  const candidates = normalizeAndDedupeCandidates(rawCandidates, {
    limits: deps.limits,
  });

  return {
    seed: validated.seed,
    generatedAtMs: deps.clock.nowMs(),
    sources: sourceOutcomes,
    // Registry results are absent at discovery time; the client populates
    // them as availability checks complete.
    candidates: candidates.map((candidate) => ({
      name: candidate.normalized,
      provenance: candidate.provenance,
      registryResults: [],
    })),
  };
}
