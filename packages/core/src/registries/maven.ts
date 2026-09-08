import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import {
  classifyExactMatch,
  isJsonArray,
  isJsonObject,
  type ClassifyInput,
  type RegistryClassification,
} from "../classify.js";
import type { RegistryDescriptor } from "../descriptors.js";

export interface MavenRegistryOptions {
  /** Solr search origin (bare-word fuzzy lookups). */
  searchOrigin: string;
  /** Maven metadata origin (qualified exact lookups). */
  metadataOrigin: string;
  timeoutMs: number;
  clock: Clock;
  /** App-supplied version for the User-Agent (never hardcoded in core). */
  version: string;
  repoUrl: string;
  fetchImpl?: typeof fetch;
  /** Full User-Agent override. */
  userAgent?: string;
}

const BARE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GROUP_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Extract the `response.docs` array from a Maven solrsearch payload. */
function mavenDocs(json: Record<string, unknown>): unknown[] | null {
  const response = json["response"];
  if (!isJsonObject(response)) return null;
  const docs = response["docs"];
  if (!isJsonArray(docs)) return null;
  return docs;
}

/** Extract the artifactId (`a`) candidates from a Maven solrsearch payload. */
function mavenArtifactIds(json: Record<string, unknown>): string[] {
  const docs = mavenDocs(json);
  if (!docs) return [];
  return docs.flatMap((doc) =>
    isJsonObject(doc) && typeof doc["a"] === "string" ? [doc["a"]] : [],
  );
}

/** Classify a Maven solrsearch payload using the shared exact-match rule. */
function classifyMavenSearch(input: ClassifyInput): RegistryClassification {
  return classifyExactMatch(input, {
    candidates: mavenArtifactIds,
    total: (json) => {
      if (!mavenDocs(json)) return null;
      const response = json["response"];
      if (!isJsonObject(response)) return null;
      const numFound = response["numFound"];
      return typeof numFound === "number" ? numFound : null;
    },
    retrieved: (json) => mavenDocs(json)?.length ?? 0,
  });
}

/**
 * Maven normalization: case-sensitive (artifact and group ids keep case). A
 * bare word is a search term; `group:artifact` (exactly one colon) is a
 * qualified coordinate.
 */
export function normalizeMavenName(value: string): RegistryValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (trimmed.includes("/")) {
    return { ok: false, reason: "Maven names use group:artifact, not slashes." };
  }
  const parts = trimmed.split(":");
  if (parts.length > 2) {
    return { ok: false, reason: "Maven names are group:artifact." };
  }
  if (parts.length === 2) {
    const [group, artifact] = parts;
    if (!group || !artifact) {
      return { ok: false, reason: "Maven names are group:artifact." };
    }
    const groupSegments = group.split(".");
    if (!groupSegments.every((segment) => GROUP_SEGMENT.test(segment)) || !BARE.test(artifact)) {
      return { ok: false, reason: "Name contains characters Maven does not allow." };
    }
    return { ok: true, name: trimmed };
  }
  if (!BARE.test(trimmed)) {
    return { ok: false, reason: "Name contains characters Maven does not allow." };
  }
  return { ok: true, name: trimmed };
}

/**
 * Maven Central adapter. A bare word is a fuzzy solrsearch check; a qualified
 * `group:artifact` is an exact maven-metadata lookup.
 */
export function createMavenRegistry(options: MavenRegistryOptions): PackageRegistry {
  const { searchOrigin, metadataOrigin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  async function lookupBare(name: string): Promise<RegistryLookupResult> {
    let response: Response;
    try {
      response = await doFetch(
        `${searchOrigin}/solrsearch/select?q=a:${encodeURIComponent(name)}&rows=20`,
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "maven request timed out." : "maven request failed.",
      };
    }

    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "maven rate limit exceeded.",
      };
    }
    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `maven responded with status ${response.status}.`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "maven returned an ambiguous response.",
      };
    }

    const classification = classifyMavenSearch({
      name,
      status: response.status,
      json: payload,
      text: "",
    });
    if (classification.status === "taken") {
      return {
        status: "taken",
        checkedAtMs: clock.nowMs(),
        fuzzy: true,
        reason: "matched via the Maven Central search index (index may lag the registry)",
      };
    }
    if (classification.status === "available") {
      return {
        status: "available",
        checkedAtMs: clock.nowMs(),
        fuzzy: true,
        reason: "not matched in the Maven Central search index (index may lag the registry)",
      };
    }
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      fuzzy: true,
      reason: classification.reason ?? "maven returned an ambiguous response.",
    };
  }

  async function lookupQualified(name: string): Promise<RegistryLookupResult> {
    const [group, artifact] = name.split(":");
    const groupPath = group?.split(".").join("/");
    let response: Response;
    try {
      response = await doFetch(`${metadataOrigin}/${groupPath}/${artifact}/maven-metadata.xml`);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "maven request timed out." : "maven request failed.",
      };
    }

    if (response.status === 404) {
      return { status: "available", checkedAtMs: clock.nowMs() };
    }
    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "maven rate limit exceeded.",
      };
    }
    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `maven responded with status ${response.status}.`,
      };
    }

    try {
      const body = await response.text();
      if (body.includes("<metadata")) {
        return { status: "taken", checkedAtMs: clock.nowMs() };
      }
    } catch {
      // fall through to ambiguous
    }
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      reason: "maven returned an ambiguous response.",
    };
  }

  return {
    id: "maven",
    validate(value: string): RegistryValidation {
      return normalizeMavenName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      if (name.includes(":")) {
        return lookupQualified(name);
      }
      return lookupBare(name);
    },
  };
}

/**
 * Maven Central registry descriptor (server venue). Bare-name checks search
 * by artifactId under any group ("consumer confusion" semantics) via the
 * shared exact-match classifier; inconclusive (paginated) searches are
 * unknown. Qualified `group:artifact` checks are exact in the adapter.
 */
export const MAVEN_DESCRIPTOR: RegistryDescriptor = {
  id: "maven",
  label: "Maven Central",
  language: "Java",
  venue: "server",
  // Coordinates are case-sensitive and use `group:artifact`; the generic
  // default normalizer would lowercase and reject the colon.
  normalize: normalizeMavenName,
  classify: classifyMavenSearch,
  checkOrigin: "https://search.maven.org",
  checkUrl: (name, origin = "https://search.maven.org") =>
    `${origin}/solrsearch/select?q=${encodeURIComponent(`a:${name}`)}`,
  link: (name) => `https://central.sonatype.com/search?q=${encodeURIComponent(`a:${name}`)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};
