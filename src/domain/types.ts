/**
 * Transport-neutral domain types. HTTP Functions, future WebMCP adapters, and
 * tests all speak this vocabulary; nothing here knows about fetch, cookies,
 * or provider response shapes.
 */

export const PROVENANCE_KINDS = [
  "input",
  "wordnik-synonym",
  "wordnik-related",
  "openrouter",
  "injected-synonym",
  "injected-creative",
] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** Candidate sources that can fail independently of one another. */
export type SourceId = "wordnik" | "openrouter";

export type SourceStatus = "ok" | "unavailable" | "skipped";

export interface SourceOutcome {
  source: SourceId;
  status: SourceStatus;
  reason?: string;
}

export type RegistryId = string;

export type RegistryStatus = "available" | "taken" | "invalid" | "unknown";

export interface RegistryLookupResult {
  status: RegistryStatus;
  /** UTC epoch milliseconds at which the registry was consulted or classified. */
  checkedAtMs: number;
  reason?: string;
}

export interface RegistryResult extends RegistryLookupResult {
  registry: RegistryId;
  /** Registry-normalized name actually checked (or rejected). */
  name: string;
}

export interface Candidate {
  /** The value as contributed by its source, before normalization. */
  raw: string;
  /** Domain-normalized identity used for deduplication. */
  normalized: string;
  provenance: ProvenanceKind[];
}

export interface ComposedCandidate {
  name: string;
  provenance: ProvenanceKind[];
  registryResults: RegistryResult[];
}

export interface SearchResponse {
  seed: string;
  generatedAtMs: number;
  sources: SourceOutcome[];
  candidates: ComposedCandidate[];
}

export const REGISTRY_STATUS_VALUES: readonly RegistryStatus[] = [
  "available",
  "taken",
  "invalid",
  "unknown",
];

export const PROVENANCE_KIND_VALUES: readonly ProvenanceKind[] = PROVENANCE_KINDS;
