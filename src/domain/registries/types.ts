import type { RegistryValidation } from "../ports";
import type { RegistryId, RegistryStatus } from "../types";

/**
 * Registry descriptors: the shared, client-safe spine for every supported
 * package registry. One descriptor per registry declares its identity, where
 * its checks run, how names are normalized, how upstream responses classify
 * into verdicts, and its cache/rate-limit posture.
 *
 * This module is imported by server adapters, client islands, and (future)
 * MCP tooling alike, so it must never import server-only configuration,
 * database, adapter, or function modules. ESLint enforces that boundary.
 */

/** Where a registry's availability check executes. */
export type RegistryVenue = "server" | "browser";

/** Classification vocabulary produced by `classify` (invalid is local-only). */
export type ClassificationStatus = Extract<RegistryStatus, "available" | "taken" | "unknown">;

/**
 * The upstream response a classifier inspects. `json` is the parsed body when
 * the body was valid JSON (null otherwise); `text` is a bounded snippet of
 * the raw body for shape fallbacks. The normalized name that was checked is
 * included so search-style endpoints can filter to exact matches.
 */
export interface ClassifyInput {
  /** Registry-normalized name the request was made for. */
  name: string;
  /** Upstream HTTP status code. */
  status: number;
  /** Parsed JSON body, or null when the body was not valid JSON. */
  json: unknown;
  /** Bounded snippet of the raw response body (may be empty). */
  text: string;
}

export interface RegistryClassification {
  status: ClassificationStatus;
  /** Why the classification landed on `unknown` (or a notable note). */
  reason?: string;
}

/**
 * Per-verdict cache freshness for the registry's verdicts. Available names
 * can become taken at any moment, so `availableMs` is always the shorter TTL.
 */
export interface RegistryCacheTtl {
  availableMs: number;
  takenMs: number;
}

export interface RegistryDescriptor {
  /** Stable identifier used in cache keys, the check API, and the UI. */
  id: RegistryId;
  /** Human label, e.g. "crates.io". */
  label: string;
  /** Primary language/ecosystem, e.g. "Rust". */
  language: string;
  /** `server`: checked via /api/check. `browser`: fetched from the client. */
  venue: RegistryVenue;
  /**
   * Registry-specific normalization + validation. Absent: the default
   * normalizer applies (trim, whitespace runs to `-`, lowercase).
   */
  normalize?: (raw: string) => RegistryValidation;
  /**
   * Map an upstream (status, body shape) to a verdict. Must be conservative:
   * ambiguity classifies as `unknown`, never `available`.
   */
  classify: (input: ClassifyInput) => RegistryClassification;
  /**
   * Public JSON endpoint that answers "does this normalized name exist?".
   * `origin` defaults to the descriptor's `checkOrigin`; the server adapter
   * passes its configured origin so tests can point at fakes.
   */
  checkUrl: (name: string, origin?: string) => string;
  /** Canonical check-endpoint origin, e.g. "https://pypi.org". */
  checkOrigin: string;
  /** Canonical package URL for a registry name (client-safe link builder). */
  link: (name: string) => string;
  cacheTtl: RegistryCacheTtl;
  /** Per-IP, per-minute server-side check budget (server venue only). */
  rateLimitPerMinute?: number;
  /** Identifying User-Agent required by some upstreams (e.g. crates.io). */
  userAgent?: string;
}

/**
 * The registry lineup type: every supported registry id, in presentation
 * order. Kept as a tuple so the compiler can enumerate the lineup.
 */
export const REGISTRY_IDS = [
  "npm",
  "pypi",
  "rubygems",
  "hex",
  "maven",
  "crates",
  "nuget",
  "packagist",
] as const;

export type LineupRegistryId = (typeof REGISTRY_IDS)[number];
