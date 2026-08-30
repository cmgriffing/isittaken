import type {
  CacheRepository,
  CacheWritePolicy,
  CandidateSource,
  CandidateSourceResult,
  Clock,
  RawCandidate,
} from "../../domain/ports";
import { encodeVersionedValue, decodeVersionedValue } from "../../domain/cache-value";
import { normalizeCandidateValue } from "../../domain/normalize-candidates";
import {
  logUpstreamError,
  readUpstreamErrorSnippet,
  sanitizeUpstreamSnippet,
} from "../../lib/upstream";

export const WORDNIK_CACHE_VALUE_VERSION = 1;

/** Wordnik relationship types treated as synonyms vs. generally related. */
export const SYNONYM_RELATIONSHIP_TYPES = ["synonym"] as const;
/**
 * Valid Wordnik relationship types (verified against the live API — its
 * validation rejects the whole request if ANY type is unknown, e.g. the
 * previously used "part-of"):
 * antonym, cross-reference, equivalent, etymologically-related-term, form,
 * has_topic, hypernym, hyponym, inflected-form, primary, related-word,
 * rhyme, same-context, suggests, synonym, variant, verb-form, verb-stem.
 * Types with no data for a word are simply omitted from the response.
 */
export const RELATED_RELATIONSHIP_TYPES = [
  "same-context",
  "hypernym",
  "hyponym",
  "related-word",
  "cross-reference",
  "equivalent",
] as const;

const KNOWN_RELATIONSHIP_TYPES: readonly string[] = [
  ...SYNONYM_RELATIONSHIP_TYPES,
  ...RELATED_RELATIONSHIP_TYPES,
];

const MAX_PER_RELATIONSHIP = 10;
const MAX_TOTAL_CANDIDATES = 40;

interface WordnikRelationship {
  relationshipType?: unknown;
  words?: unknown;
}

export interface WordnikSourceOptions {
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  clock: Clock;
  cache?: CacheRepository;
  /** TTL policy for the `wordnik` cache family (from server configuration). */
  cachePolicy?: CacheWritePolicy;
  fetchImpl?: typeof fetch;
}

function provenanceFor(relationshipType: string): RawCandidate["provenance"] {
  return (SYNONYM_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)
    ? "wordnik-synonym"
    : "wordnik-related";
}

function isValidWord(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !value.includes("/")
  );
}

/**
 * Wordnik candidate source. Fetches configured synonym and related-word
 * relationships, validates the response shape, assigns per-relationship
 * provenance, and caches results in the `wordnik` family. Failures map to an
 * `unavailable` outcome and are never cached as success.
 */
export function createWordnikSource(options: WordnikSourceOptions): CandidateSource {
  const { apiKey, baseUrl, timeoutMs } = options;
  const doFetch = options.fetchImpl ?? fetch;

  const relationshipTypes = [...SYNONYM_RELATIONSHIP_TYPES, ...RELATED_RELATIONSHIP_TYPES].join(
    ",",
  );

  async function fetchUpstream(seed: string): Promise<CandidateSourceResult> {
    const url =
      `${baseUrl}/word.json/${encodeURIComponent(seed)}/relatedWords` +
      `?useCanonical=false&relationshipTypes=${encodeURIComponent(relationshipTypes)}` +
      `&limitPerRelationshipType=${MAX_PER_RELATIONSHIP}&api_key=${encodeURIComponent(apiKey ?? "")}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unavailable",
        reason: timedOut ? "Wordnik request timed out." : "Wordnik request failed.",
      };
    }

    if (!response.ok) {
      // Capture the upstream error body (bounded, secret-redacted) so the
      // log and the operator-facing reason explain *why* — e.g. invalid
      // API key or bad parameters on a 400.
      const snippet = await readUpstreamErrorSnippet(response);
      logUpstreamError("wordnik", response.status, snippet, { seed });
      const detail = snippet ? `: ${snippet}` : "";
      return {
        status: "unavailable",
        reason:
          response.status === 429
            ? `Wordnik rate limit exceeded.${detail}`
            : `Wordnik responded with status ${response.status}.${detail}`,
      };
    }

    const bodyText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch {
      const snippet = sanitizeUpstreamSnippet(bodyText);
      logUpstreamError("wordnik", response.status, snippet || "(non-JSON body)", { seed });
      return { status: "unavailable", reason: "Wordnik returned a non-JSON response." };
    }

    if (!Array.isArray(payload)) {
      logUpstreamError("wordnik", response.status, sanitizeUpstreamSnippet(bodyText), {
        seed,
        problem: "unexpected_shape",
      });
      return { status: "unavailable", reason: "Wordnik response shape was unexpected." };
    }

    const candidates: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const entry of payload as WordnikRelationship[]) {
      const relationshipType =
        typeof entry?.relationshipType === "string" ? entry.relationshipType : "";
      // Only trust relationships we explicitly requested; ignore drift.
      if (!KNOWN_RELATIONSHIP_TYPES.includes(relationshipType)) continue;
      if (!Array.isArray(entry.words)) continue;
      const provenance = provenanceFor(relationshipType);
      for (const word of entry.words) {
        if (!isValidWord(word)) continue;
        const identity = normalizeCandidateValue(word);
        if (!identity || seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({ value: word, provenance });
        if (candidates.length >= MAX_TOTAL_CANDIDATES) break;
      }
      if (candidates.length >= MAX_TOTAL_CANDIDATES) break;
    }

    return { status: "ok", candidates };
  }

  return {
    id: "wordnik",
    async fetch(seed: string): Promise<CandidateSourceResult> {
      if (!apiKey) {
        return { status: "skipped", reason: "WORDNIK_API_KEY is not configured." };
      }

      const cacheKey = `v${WORDNIK_CACHE_VALUE_VERSION}:rel:${normalizeCandidateValue(
        seed,
      )}:${relationshipTypes}`;

      try {
        const cached = await options.cache?.read("wordnik", cacheKey);
        if (cached?.status === "fresh") {
          const data = decodeVersionedValue<{ candidates: RawCandidate[] }>(
            cached.valueJson,
            WORDNIK_CACHE_VALUE_VERSION,
          );
          if (data && Array.isArray(data.candidates)) {
            return { status: "ok", candidates: data.candidates };
          }
        }
      } catch {
        // Cache failure degrades to an upstream fetch.
      }

      const result = await fetchUpstream(seed);

      if (result.status === "ok" && options.cache && options.cachePolicy) {
        try {
          await options.cache.write(
            "wordnik",
            cacheKey,
            encodeVersionedValue(WORDNIK_CACHE_VALUE_VERSION, { candidates: result.candidates }),
            options.cachePolicy,
          );
        } catch {
          // Cache write failure never fails the source.
        }
      }

      return result;
    },
  };
}
