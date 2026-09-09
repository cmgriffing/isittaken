import type { ProvenanceKind, RegistryId, RegistryLookupResult, SourceId } from "./types.js";

/**
 * Provider and repository ports. Adapters implement these interfaces; use
 * cases depend only on the contracts.
 */

export interface Clock {
  /** UTC epoch milliseconds. */
  nowMs(): number;
}

/** A candidate value contributed by a source, with its provenance label. */
export interface RawCandidate {
  value: string;
  provenance: ProvenanceKind;
}

export type CandidateSourceResult =
  | { status: "ok"; candidates: RawCandidate[] }
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: string };

export interface CandidateSource {
  readonly id: SourceId;
  fetch(seed: string): Promise<CandidateSourceResult>;
}

export type RegistryValidation = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Registry-specific normalization and validation belong to the adapter; the
 * availability vocabulary is registry-independent.
 */
export interface PackageRegistry {
  readonly id: RegistryId;
  validate(value: string): RegistryValidation;
  lookup(name: string): Promise<RegistryLookupResult>;
}
