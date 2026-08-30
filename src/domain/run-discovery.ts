import { mapWithConcurrency } from "../lib/concurrency";
import type { CandidateSource, PackageRegistry, RawCandidate } from "./ports";
import type { RegistryLookupResult } from "./types";
import { normalizeAndDedupeCandidates } from "./normalize-candidates";
import type { ComposedCandidate, RegistryResult, SearchResponse, SourceOutcome } from "./types";
import type { SearchLimits } from "./validate-search-request";

/** Structural input for discovery; `ValidatedSearchRequest` satisfies it. */
export interface DiscoveryInput {
  seed: string;
  injectedSynonyms?: readonly string[];
  injectedCreatives?: readonly string[];
}

export interface DiscoveryDeps {
  sources: readonly CandidateSource[];
  registries: readonly PackageRegistry[];
  clock: { nowMs(): number };
  limits: SearchLimits;
  /** Max concurrent upstream availability checks per registry. */
  registryConcurrency: number;
}

/**
 * Ordinary (non-creative) discovery pipeline:
 *   collect source candidates -> normalize/dedupe -> registry validation ->
 *   bounded-concurrency availability checks -> compose the response.
 *
 * Sources fail independently: a failed source never blocks other candidates.
 * Registry lookups never throw; ambiguity maps to `unknown`. Invalid names
 * are classified without contacting the registry.
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

  const registryResults = await checkCandidatesAcrossRegistries(candidates, deps);

  const composed: ComposedCandidate[] = candidates.map((candidate, index) => ({
    name: candidate.normalized,
    provenance: candidate.provenance,
    registryResults: registryResults[index] ?? [],
  }));

  return {
    seed: validated.seed,
    generatedAtMs: deps.clock.nowMs(),
    sources: sourceOutcomes,
    candidates: composed,
  };
}

/**
 * For every candidate and registry: validate locally (invalid classification
 * never touches the network), dedupe registry-normalized names, run lookups
 * with bounded concurrency, and join results back per candidate.
 */
async function checkCandidatesAcrossRegistries(
  candidates: readonly { normalized: string }[],
  deps: DiscoveryDeps,
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
