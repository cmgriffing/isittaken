import { mapWithConcurrency } from "./concurrency.js";
import type { CandidateSource, Clock, PackageRegistry, RawCandidate } from "./ports.js";
import { normalizeAndDedupeCandidates } from "./normalize-candidates.js";
import type {
  RegistryLookupResult,
  RegistryResult,
  SearchResponse,
  SourceOutcome,
} from "./types.js";
import type { SearchLimits } from "./validate-search-request.js";

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

export interface CheckAcrossRegistriesDeps {
  registries: readonly PackageRegistry[];
  clock: Clock;
  /** Max concurrent upstream availability checks per registry. */
  registryConcurrency: number;
}

/**
 * For every candidate and registry: validate locally (invalid classification
 * never touches the network), dedupe registry-normalized names, run lookups
 * with bounded concurrency, and join results back per candidate.
 */
export async function checkCandidatesAcrossRegistries(
  candidates: readonly { normalized: string }[],
  deps: CheckAcrossRegistriesDeps,
): Promise<RegistryResult[][]> {
  const results: RegistryResult[][] = candidates.map(() => []);

  for (const registry of deps.registries) {
    // Validate every candidate; keep the registry-normalized identity.
    const normalizedNames = candidates.map((candidate) => {
      const validation = registry.validate(candidate.normalized);
      if (validation.ok) {
        return { ok: true as const, name: validation.name };
      }
      return {
        ok: false as const,
        name: candidate.normalized,
        reason: validation.reason,
      };
    });

    // Unique valid names, first-seen order.
    const uniqueNames: string[] = [];
    const nameIndex = new Map<string, number>();
    normalizedNames.forEach((entry, candidateIndex) => {
      if (!entry.ok) return;
      const existing = nameIndex.get(entry.name);
      if (existing !== undefined) {
        nameIndex.set(entry.name, existing);
        return;
      }
      nameIndex.set(entry.name, candidateIndex);
      uniqueNames.push(entry.name);
    });

    const lookupResults = await mapWithConcurrency(
      uniqueNames,
      deps.registryConcurrency,
      async (name) => {
        try {
          return await registry.lookup(name);
        } catch (error) {
          return {
            status: "unknown" as const,
            checkedAtMs: deps.clock.nowMs(),
            reason: error instanceof Error ? error.message : "Registry lookup failed.",
          } satisfies RegistryLookupResult;
        }
      },
    );

    const checked = new Map<string, RegistryLookupResult>();
    uniqueNames.forEach((name, index) => {
      const result = lookupResults[index];
      if (result) checked.set(name, result);
    });

    normalizedNames.forEach((entry, candidateIndex) => {
      if (!entry.ok) {
        results[candidateIndex]?.push({
          registry: registry.id,
          name: entry.name,
          status: "invalid",
          checkedAtMs: deps.clock.nowMs(),
          reason: entry.reason,
        });
        return;
      }
      const lookup = checked.get(entry.name);
      if (lookup) {
        results[candidateIndex]?.push({
          registry: registry.id,
          name: entry.name,
          ...lookup,
        });
      }
    });
  }

  return results;
}
