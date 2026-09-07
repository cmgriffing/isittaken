import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";

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

    try {
      const payload: unknown = await response.json();
      const docs = (payload as { response?: { docs?: unknown } }).response?.docs;
      if (!Array.isArray(docs)) {
        return {
          status: "unknown",
          checkedAtMs: clock.nowMs(),
          reason: "maven returned an ambiguous response.",
        };
      }
      const matched = docs.some((doc) => (doc as { a?: unknown }).a === name);
      if (matched) {
        return {
          status: "taken",
          checkedAtMs: clock.nowMs(),
          fuzzy: true,
          reason: "matched via the Maven Central search index (index may lag the registry)",
        };
      }
      return {
        status: "available",
        checkedAtMs: clock.nowMs(),
        fuzzy: true,
        reason: "not matched in the Maven Central search index (index may lag the registry)",
      };
    } catch {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "maven returned an ambiguous response.",
      };
    }
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
