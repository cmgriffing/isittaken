import type { RegistryStatus } from "./types.js";
import type { RegistryValidation } from "./ports.js";

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

/** Conservative shared cap; npm's documented limit, adopted as the default. */
export const DEFAULT_MAX_NAME_LENGTH = 214;

/**
 * The default normalization the descriptor contract specifies: trim, collapse
 * whitespace runs to `-`, lowercase — with validation so an invalid name is
 * classified `invalid` locally and never reaches the upstream registry.
 * Descriptors override this via `normalize`; `normalizerFor` applies it as
 * the fallback.
 */
export function normalizeRegistryName(raw: string): RegistryValidation {
  const name = raw.trim().replace(/\s+/g, "-").toLowerCase();
  if (name.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (name.length > DEFAULT_MAX_NAME_LENGTH) {
    return { ok: false, reason: `Name exceeds the ${DEFAULT_MAX_NAME_LENGTH}-character limit.` };
  }
  if (!/^[a-z0-9]/.test(name)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9._-]+$/.test(name)) {
    return {
      ok: false,
      reason: "Name contains characters the registry does not allow.",
    };
  }
  if (name.endsWith("-")) {
    return { ok: false, reason: "Name cannot end with a hyphen." };
  }
  return { ok: true, name };
}

/** True for a parsed, non-array JSON object body. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a parsed JSON array body. */
export function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function unknownReason(input: ClassifyInput): string {
  if (input.status === 429) return "upstream rate limit exceeded.";
  if (input.status >= 200 && input.status < 300) return "ambiguous response.";
  if (input.status >= 400) return `responded with status ${input.status}.`;
  return `unexpected response status ${input.status}.`;
}

/**
 * The common flat-registry pattern (npm, PyPI, RubyGems, Hex, crates.io,
 * NuGet): 404 not-found for a validated name means available; a 2xx whose
 * body passes `shape` means taken; anything else is unknown.
 */
export function classifyNotFound(
  input: ClassifyInput,
  options: {
    notFoundStatus?: number;
    /** Additional required body shape for a 2xx "taken" classification. */
    shape?: (json: unknown) => boolean;
  } = {},
): RegistryClassification {
  const notFoundStatus = options.notFoundStatus ?? 404;
  if (input.status === notFoundStatus) {
    return { status: "available" };
  }
  if (input.status >= 200 && input.status < 300) {
    const shaped = isJsonObject(input.json) && (options.shape?.(input.json) ?? true);
    if (shaped) return { status: "taken" };
    return { status: "unknown", reason: unknownReason(input) };
  }
  return { status: "unknown", reason: unknownReason(input) };
}

/**
 * Exact-match filtering over a search-style response (Maven, Packagist):
 * return `taken` when at least one candidate field equals the checked name,
 * `unknown` when the response is not confidently complete (missing totals,
 * paginated results), and `available` only when the complete result set was
 * retrieved and contains no exact match.
 */
export function classifyExactMatch(
  input: ClassifyInput,
  options: {
    /** Extract the candidate name strings from the parsed body. */
    candidates: (json: Record<string, unknown>) => string[];
    /** Trustworthy total result count, or null when the body lacks one. */
    total: (json: Record<string, unknown>) => number | null;
    /** Number of results actually present in this body. */
    retrieved: (json: Record<string, unknown>) => number;
  },
): RegistryClassification {
  if (input.status === 429) {
    return { status: "unknown", reason: unknownReason(input) };
  }
  if (input.status < 200 || input.status >= 300 || !isJsonObject(input.json)) {
    return { status: "unknown", reason: unknownReason(input) };
  }

  const matches = options.candidates(input.json).some((candidate) => candidate === input.name);
  if (matches) return { status: "taken" };

  const total = options.total(input.json);
  if (total === null) {
    // No trustworthy completeness signal: a match could hide on another page.
    return { status: "unknown", reason: "inconclusive search results." };
  }
  if (options.retrieved(input.json) < total) {
    // Paginated: an exact match could exist beyond the first page.
    return { status: "unknown", reason: "inconclusive search results." };
  }
  return { status: "available" };
}
