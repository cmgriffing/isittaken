import type { Candidate, ProvenanceKind } from "./types";
import type { SearchLimits } from "./validate-search-request";
import type { RawCandidate } from "./ports";

/**
 * Domain-normalize a candidate value into its deduplication identity:
 * unicode NFKC, trimmed, lowercased, with whitespace runs collapsed.
 * Registry-specific normalization (e.g. npm's) stays in the registry adapter.
 */
export function normalizeCandidateValue(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface NormalizeOptions {
  limits: Pick<SearchLimits, "maxCandidateLength" | "maxTotalCandidates">;
}

/**
 * Remove invalid values, merge equivalent candidates, and union provenance.
 * Order of first appearance is preserved; provenance lists keep the order in
 * which sources contributed.
 */
export function normalizeAndDedupeCandidates(
  raw: readonly RawCandidate[],
  options: NormalizeOptions,
): Candidate[] {
  const byNormalized = new Map<string, Candidate>();
  const seenProvenance = new Map<Candidate, Set<ProvenanceKind>>();

  for (const item of raw) {
    const normalized = normalizeCandidateValue(item.value);
    if (normalized.length === 0) continue;
    if (normalized.length > options.limits.maxCandidateLength) continue;

    const existing = byNormalized.get(normalized);
    if (existing) {
      const provenance = seenProvenance.get(existing);
      if (provenance && !provenance.has(item.provenance)) {
        provenance.add(item.provenance);
        existing.provenance = [...provenance];
      }
      continue;
    }

    const candidate: Candidate = {
      raw: item.value,
      normalized,
      provenance: [item.provenance],
    };
    byNormalized.set(normalized, candidate);
    seenProvenance.set(candidate, new Set(candidate.provenance));
  }

  const merged = [...byNormalized.values()];
  if (merged.length > options.limits.maxTotalCandidates) {
    return merged.slice(0, options.limits.maxTotalCandidates);
  }
  return merged;
}
