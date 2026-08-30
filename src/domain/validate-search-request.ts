import { SearchValidationError } from "./errors";

/** Transport-neutral search request: seed plus optional injected candidates. */
export interface SearchRequest {
  seed: string;
  /** Caller-supplied synonym alternatives (e.g. from an agent client). */
  injectedSynonyms?: readonly string[];
  /** Caller-supplied creative alternatives (e.g. from an agent client). */
  injectedCreatives?: readonly string[];
}

export interface SearchLimits {
  maxSeedLength: number;
  maxInjectedSynonyms: number;
  maxInjectedCreatives: number;
  maxCandidateLength: number;
  maxTotalCandidates: number;
}

export interface ValidatedSearchRequest {
  seed: string;
  injectedSynonyms: string[];
  injectedCreatives: string[];
}

/**
 * Seeds are natural-language words: unicode letters/numbers, spaces,
 * apostrophes, hyphens, underscores and dots. Anything else (including
 * scope separators) is rejected before any upstream call.
 */
const SEED_PATTERN = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} '_\-.]*$/u;

/**
 * Injected candidates must look like plausible package-name material:
 * unicode letters/numbers, spaces, hyphens, underscores, dots.
 */
const INJECTED_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '_\-.]*$/u;

function assertString(value: unknown, code: "invalid_seed" | "invalid_injected"): string {
  if (typeof value !== "string") {
    throw new SearchValidationError(code, "Value must be a string.");
  }
  return value;
}

function rejectScoped(
  value: string,
  code: "invalid_seed" | "invalid_injected" | "unsupported_scope",
): void {
  if (value.includes("/")) {
    throw new SearchValidationError(
      code,
      "Scoped npm names are not supported; only unscoped package names can be checked.",
    );
  }
}

function validateInjected(
  values: readonly unknown[],
  label: "synonym" | "creative",
  code: "invalid_injected",
  limits: SearchLimits,
): string[] {
  const max = label === "synonym" ? limits.maxInjectedSynonyms : limits.maxInjectedCreatives;
  if (values.length > max) {
    throw new SearchValidationError(
      "over_limit",
      `Injected ${label} candidates exceed the limit of ${max}.`,
    );
  }
  const cleaned: string[] = [];
  for (const value of values) {
    const trimmed = assertString(value, code).trim();
    if (trimmed.length === 0) {
      throw new SearchValidationError(code, `Injected ${label} candidates must be non-empty.`);
    }
    if (trimmed.length > limits.maxCandidateLength) {
      throw new SearchValidationError(
        "over_limit",
        `Injected ${label} candidate exceeds ${limits.maxCandidateLength} characters.`,
      );
    }
    rejectScoped(trimmed, "unsupported_scope");
    if (!INJECTED_PATTERN.test(trimmed)) {
      throw new SearchValidationError(
        code,
        `Injected ${label} candidate contains unsupported characters.`,
      );
    }
    cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * Validate the raw request. Throws {@link SearchValidationError} before any
 * upstream provider can be contacted. Scoped targets are rejected explicitly.
 */
export function validateSearchRequest(
  request: SearchRequest,
  limits: SearchLimits,
): ValidatedSearchRequest {
  assertString(request.seed, "invalid_seed");
  const seed = request.seed.trim();
  if (seed.length === 0) {
    throw new SearchValidationError("invalid_seed", "Seed term must be non-empty.");
  }
  if (seed.length > limits.maxSeedLength) {
    throw new SearchValidationError(
      "invalid_seed",
      `Seed term exceeds ${limits.maxSeedLength} characters.`,
    );
  }
  rejectScoped(seed, "unsupported_scope");
  if (!SEED_PATTERN.test(seed)) {
    throw new SearchValidationError("invalid_seed", "Seed term contains unsupported characters.");
  }

  const injectedSynonyms = validateInjected(
    request.injectedSynonyms ?? [],
    "synonym",
    "invalid_injected",
    limits,
  );
  const injectedCreatives = validateInjected(
    request.injectedCreatives ?? [],
    "creative",
    "invalid_injected",
    limits,
  );

  const total = 1 + injectedSynonyms.length + injectedCreatives.length;
  if (total > limits.maxTotalCandidates) {
    throw new SearchValidationError(
      "over_limit",
      `Request expands to ${total} candidates, exceeding the limit of ${limits.maxTotalCandidates}.`,
    );
  }

  return { seed, injectedSynonyms, injectedCreatives };
}
