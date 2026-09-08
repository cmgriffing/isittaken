// TEMPORARY (phase 1 merge shim — do not extend).
//
// Main's registry descriptors lived in `src/domain/registries/*` on the
// pre-monorepo tree. This change's design (D2) makes `@isittaken/core` the
// single source of registry knowledge: phase 2 task 2.1 adds the descriptor
// surface to the core adapters, and phase 3 task 3.1 re-points main's
// client/endpoint imports at `@isittaken/core` and deletes this module.
//
// Everything below is ported verbatim from `origin/main`'s
// `src/domain/registries/*` so main's client code, the check endpoint, and
// their tests behave exactly as they did upstream.

import type { RegistryId, RegistryStatus, RegistryValidation } from "@isittaken/core";
import { normalizeNpmName as coreNormalizeNpmName } from "@isittaken/core";

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

/** npm unscoped-name normalization (main's rule; core equivalent exists). */
export function normalizeNpmName(value: string): RegistryValidation {
  return coreNormalizeNpmName(value);
}

/**
 * PyPI PEP 503 normalization (ported from main verbatim): lowercase, and runs
 * of `-`, `_`, `.`, and whitespace collapse to a single hyphen, so "back end"
 * and "back-end" are the same project. (Core's normalizePypiName differs —
 * it does not collapse whitespace — task 2.3 reconciles the two rules.)
 */
export function normalizePypiName(value: string): RegistryValidation {
  const name = value
    .trim()
    .replace(/[-_.\s]+/g, "-")
    .toLowerCase();
  if (name.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (name.length > DEFAULT_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds the ${DEFAULT_MAX_NAME_LENGTH}-character limit.`,
    };
  }
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    return { ok: false, reason: "PyPI names must begin and end with a letter or digit." };
  }
  if (!/^[a-z0-9.-]+$/.test(name)) {
    return { ok: false, reason: "Name contains characters PyPI does not allow." };
  }
  return { ok: true, name };
}

/** Hex normalization: package names are lowercase (ported from main). */
export function normalizeHexName(value: string): RegistryValidation {
  const name = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (name.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (name.length > DEFAULT_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds the ${DEFAULT_MAX_NAME_LENGTH}-character limit.`,
    };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return {
      ok: false,
      reason: "Name contains characters Hex does not allow.",
    };
  }
  return { ok: true, name };
}

/** npm registry descriptor (server venue). Scoped names are unsupported. */
export const NPM_DESCRIPTOR: RegistryDescriptor = {
  id: "npm",
  label: "npm",
  language: "JavaScript / TypeScript",
  venue: "server",
  normalize: normalizeNpmName,
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://registry.npmjs.org",
  checkUrl: (name, origin = "https://registry.npmjs.org") =>
    `${origin}/${encodeURIComponent(name)}`,
  link: (name) => `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 60,
};

/** PyPI registry descriptor (server venue). Names normalize per PEP 503. */
export const PYPI_DESCRIPTOR: RegistryDescriptor = {
  id: "pypi",
  label: "PyPI",
  language: "Python",
  venue: "server",
  normalize: normalizePypiName,
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://pypi.org",
  checkUrl: (name, origin = "https://pypi.org") =>
    `${origin}/pypi/${encodeURIComponent(name)}/json`,
  link: (name) => `https://pypi.org/project/${encodeURIComponent(name)}/`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 60,
};

/** RubyGems registry descriptor (server venue). */
export const RUBYGEMS_DESCRIPTOR: RegistryDescriptor = {
  id: "rubygems",
  label: "RubyGems",
  language: "Ruby",
  venue: "server",
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://rubygems.org",
  checkUrl: (name, origin = "https://rubygems.org") =>
    `${origin}/api/v1/gems/${encodeURIComponent(name)}.json`,
  link: (name) => `https://rubygems.org/gems/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};

/** Hex registry descriptor (server venue). Package names are lowercase. */
export const HEX_DESCRIPTOR: RegistryDescriptor = {
  id: "hex",
  label: "Hex",
  language: "Elixir",
  venue: "server",
  normalize: normalizeHexName,
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://hex.pm",
  checkUrl: (name, origin = "https://hex.pm") =>
    `${origin}/api/packages/${encodeURIComponent(name)}`,
  link: (name) => `https://hex.pm/packages/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};

function mavenDocs(json: Record<string, unknown>): unknown[] | null {
  const response = json["response"];
  if (!isJsonObject(response)) return null;
  const docs = response["docs"];
  if (!isJsonArray(docs)) return null;
  return docs;
}

function mavenArtifactIds(json: Record<string, unknown>): string[] {
  const docs = mavenDocs(json);
  if (!docs) return [];
  return docs.flatMap((doc) =>
    isJsonObject(doc) && typeof doc["a"] === "string" ? [doc["a"]] : [],
  );
}

/**
 * Maven Central registry descriptor (server venue). Bare-name checks search
 * by artifactId under any group ("consumer confusion" semantics) and filter
 * results to exact artifactId matches; inconclusive searches are unknown.
 */
export const MAVEN_DESCRIPTOR: RegistryDescriptor = {
  id: "maven",
  label: "Maven Central",
  language: "Java",
  venue: "server",
  classify: (input) =>
    classifyExactMatch(input, {
      candidates: mavenArtifactIds,
      total: (json) => {
        if (!mavenDocs(json)) return null;
        const response = json["response"];
        if (!isJsonObject(response)) return null;
        const numFound = response["numFound"];
        return typeof numFound === "number" ? numFound : null;
      },
      retrieved: (json) => mavenDocs(json)?.length ?? 0,
    }),
  checkOrigin: "https://search.maven.org",
  checkUrl: (name, origin = "https://search.maven.org") =>
    `${origin}/solrsearch/select?q=${encodeURIComponent(`a:${name}`)}`,
  link: (name) => `https://central.sonatype.com/search?q=${encodeURIComponent(`a:${name}`)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};

/**
 * crates.io registry descriptor (browser venue: the API serves CORS headers
 * and expects user traffic). The `userAgent` identifies server-side checks
 * should the venue ever flip to "server".
 */
export const CRATES_DESCRIPTOR: RegistryDescriptor = {
  id: "crates",
  label: "crates.io",
  language: "Rust",
  venue: "browser",
  classify: (input) =>
    classifyNotFound(input, {
      shape: (json) => isJsonObject(json) && "crate" in json,
    }),
  checkOrigin: "https://crates.io",
  checkUrl: (name, origin = "https://crates.io") =>
    `${origin}/api/v1/crates/${encodeURIComponent(name)}`,
  link: (name) => `https://crates.io/crates/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  userAgent: "isittaken/0.1.0 (package name availability checker)",
};

function hasVersionsArray(json: unknown): boolean {
  return isJsonObject(json) && isJsonArray(json["versions"]);
}

/** NuGet registry descriptor (browser venue; the flat container serves CORS). */
export const NUGET_DESCRIPTOR: RegistryDescriptor = {
  id: "nuget",
  label: "NuGet",
  language: ".NET",
  venue: "browser",
  classify: (input) =>
    classifyNotFound(input, {
      shape: hasVersionsArray,
    }),
  checkOrigin: "https://api.nuget.org",
  checkUrl: (name, origin = "https://api.nuget.org") =>
    `${origin}/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`,
  link: (name) => `https://www.nuget.org/packages/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
};

function packagistResults(json: Record<string, unknown>): unknown[] | null {
  const results = json["results"];
  return isJsonArray(results) ? results : null;
}

function packagistNameParts(json: Record<string, unknown>): string[] {
  const results = packagistResults(json);
  if (!results) return [];
  return results.flatMap((result) => {
    if (!isJsonObject(result) || typeof result["name"] !== "string") return [];
    // Names are `vendor/package`; the bare name matches the package part.
    const namePart = result["name"].split("/")[1];
    return namePart ? [namePart] : [];
  });
}

/**
 * Packagist registry descriptor (browser venue). Packagist package pages
 * require a vendor prefix, so bare-name checks run through the search JSON
 * with exact name-part filtering; inconclusive searches are unknown.
 */
export const PACKAGIST_DESCRIPTOR: RegistryDescriptor = {
  id: "packagist",
  label: "Packagist",
  language: "PHP",
  venue: "browser",
  classify: (input) =>
    classifyExactMatch(input, {
      candidates: packagistNameParts,
      total: (json) => {
        if (!packagistResults(json)) return null;
        const total = json["total"];
        return typeof total === "number" ? total : null;
      },
      retrieved: (json) => packagistResults(json)?.length ?? 0,
    }),
  checkOrigin: "https://packagist.org",
  checkUrl: (name, origin = "https://packagist.org") =>
    `${origin}/search.json?q=${encodeURIComponent(name)}`,
  link: (name) => `https://packagist.org/?query=${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
};

/**
 * The supported registry lineup, in presentation order: npm, PyPI, RubyGems,
 * Hex, and Maven run server-side (checked via /api/check); crates.io, NuGet,
 * and Packagist are fetched directly from the browser (CORS-enabled APIs).
 * Go (pkg.go.dev) returns in phase 3 as a server venue (D4).
 */
export const REGISTRY_LINEUP: readonly RegistryDescriptor[] = [
  NPM_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  RUBYGEMS_DESCRIPTOR,
  HEX_DESCRIPTOR,
  MAVEN_DESCRIPTOR,
  CRATES_DESCRIPTOR,
  NUGET_DESCRIPTOR,
  PACKAGIST_DESCRIPTOR,
];

/** Look up a descriptor by registry id, or undefined when unsupported. */
export function registryById(id: string): RegistryDescriptor | undefined {
  return REGISTRY_LINEUP.find((descriptor) => descriptor.id === id);
}

/**
 * The normalizer a descriptor applies: its own override, or the shared
 * default (trim, whitespace runs to `-`, lowercase) with validation.
 */
export function normalizerFor(descriptor: RegistryDescriptor): (raw: string) => RegistryValidation {
  return descriptor.normalize ?? normalizeRegistryName;
}
