import type { ProvenanceKind, RegistryId, RegistryLookupResult, SourceId } from "./types";

/**
 * Provider and repository ports. Adapters implement these interfaces; use
 * cases depend only on the contracts.
 */

export interface Clock {
  /** UTC epoch milliseconds. */
  nowMs(): number;
}

export interface IdGenerator {
  newId(): string;
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

export type CacheFamily = "wordnik" | "openrouter" | "npm-available" | "npm-taken";

export type CacheRead =
  | { status: "fresh"; valueJson: string }
  | { status: "stale"; valueJson?: string }
  | { status: "expired" }
  | { status: "miss" };

export interface CacheWritePolicy {
  /** How long the entry may serve as a fresh result. */
  freshForMs: number;
  /** How long the entry is retained (for fallback/diagnostics) after freshness. */
  retainForMs: number;
}

export interface CacheRepository {
  read(family: CacheFamily, key: string): Promise<CacheRead>;
  write(
    family: CacheFamily,
    key: string,
    valueJson: string,
    policy: CacheWritePolicy,
  ): Promise<void>;
}

export interface UserRecord {
  id: string;
  githubId: string;
  githubLogin: string;
  avatarUrl: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UserRepository {
  upsertByGithubId(
    input: { githubId: string; githubLogin: string; avatarUrl: string | null },
    nowMs: number,
  ): Promise<UserRecord>;
  getById(id: string): Promise<UserRecord | null>;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenAtMs: number;
}

export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  findValid(tokenHash: string, nowMs: number): Promise<SessionRecord | null>;
  touch(tokenHash: string, nowMs: number): Promise<void>;
  revoke(tokenHash: string): Promise<void>;
}

export type QuotaSubjectType = "user" | "application";

export type QuotaWindowKind = "burst-minute" | "periodic-day";

export interface QuotaSubject {
  subjectType: QuotaSubjectType;
  subjectId: string;
}

export interface ReservationResult {
  granted: boolean;
  usedAfter: number;
  limit: number;
  /** When the current window ends (UTC epoch ms), for retry-after metadata. */
  resetsAtMs: number;
}

export interface UsageSettlement {
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostMicroUSD?: number;
}

export interface QuotaRepository {
  /** Atomically conditionally-increment a usage bucket; never exceeds limit. */
  reserve(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    limit: number,
    amount: number,
  ): Promise<ReservationResult>;
  /** Record actual usage metadata on an already-reserved bucket. */
  settle(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    usage: UsageSettlement,
  ): Promise<void>;
  /** Return previously reserved amount to the bucket (no burst refunds). */
  refund(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    amount: number,
  ): Promise<void>;
  read(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
  ): Promise<{ used: number; limit: number | null }>;
}

export interface GenerationUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export type CreativeProviderResult =
  | { status: "ok"; candidates: string[]; usage?: GenerationUsage }
  | {
      status: "failed";
      reason: string;
      /** Whether the longer-period quota may be refunded. */ refundable: boolean;
    };

/**
 * Paid creative-generation providers (OpenRouter today). Quota reservation,
 * caching, and candidate validation live in the use case; the provider only
 * talks to the model API.
 */
export interface CreativeProvider {
  readonly id: "openrouter";
  generate(seed: string, count: number): Promise<CreativeProviderResult>;
}
