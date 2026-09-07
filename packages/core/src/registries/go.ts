import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";

export interface GoRegistryOptions {
  /** pkg.go.dev search origin (bare-word fuzzy lookups). */
  searchOrigin: string;
  /** Go module proxy origin (qualified exact lookups). */
  proxyOrigin: string;
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
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Go normalization: a bare word is a search term; a qualified module path has
 * at least two `/`-segments whose first segment contains a dot. Uppercase is
 * allowed pre-escape.
 */
export function normalizeGoName(value: string): RegistryValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (trimmed.includes(" ")) {
    return { ok: false, reason: "Name cannot contain spaces." };
  }
  if (trimmed.includes("/")) {
    const segments = trimmed.split("/");
    if (segments.length < 2) {
      return { ok: false, reason: "not a valid Go module path" };
    }
    const first = segments[0];
    if (!first || !first.includes(".")) {
      return { ok: false, reason: "not a valid Go module path" };
    }
    if (!segments.every((segment) => PATH_SEGMENT.test(segment))) {
      return { ok: false, reason: "Name contains characters Go does not allow." };
    }
    return { ok: true, name: trimmed };
  }
  if (!BARE.test(trimmed)) {
    return { ok: false, reason: "Name contains characters Go does not allow." };
  }
  return { ok: true, name: trimmed };
}

/** Escape a module path for the Go module proxy: uppercase -> "!" + lowercase. */
function escapeModulePath(path: string): string {
  let escaped = "";
  for (const char of path) {
    if (char >= "A" && char <= "Z") {
      escaped += `!${char.toLowerCase()}`;
    } else {
      escaped += char;
    }
  }
  return escaped;
}

/**
 * Go adapter. A bare word is a best-effort fuzzy check of the pkg.go.dev
 * search page; a qualified module path is a near-exact proxy lookup. The
 * bare-word path honestly returns unknown when pkg.go.dev rate-limits or
 * blocks the client.
 */
export function createGoRegistry(options: GoRegistryOptions): PackageRegistry {
  const { searchOrigin, proxyOrigin, clock } = options;
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
      response = await doFetch(`${searchOrigin}/search?q=${encodeURIComponent(name)}`);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "go request timed out." : "go request failed.",
      };
    }

    if (response.status === 429 || response.status === 403) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "pkg.go.dev rate-limited or blocked the request.",
      };
    }
    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `go responded with status ${response.status}.`,
      };
    }

    try {
      const html = await response.text();
      const candidates = extractModuleCandidates(html);
      const matched = candidates.some((candidate) => {
        const finalSegment = candidate.slice(candidate.lastIndexOf("/") + 1);
        return finalSegment.toLowerCase() === name;
      });
      if (matched) {
        return {
          status: "taken",
          checkedAtMs: clock.nowMs(),
          fuzzy: true,
          reason: "matched via the pkg.go.dev search page (search may lag the index)",
        };
      }
      return {
        status: "available",
        checkedAtMs: clock.nowMs(),
        fuzzy: true,
        reason: "not matched on the pkg.go.dev search page (search may lag the index)",
      };
    } catch {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "go returned an ambiguous response.",
      };
    }
  }

  async function lookupQualified(name: string): Promise<RegistryLookupResult> {
    const escaped = escapeModulePath(name);
    let response: Response;
    try {
      response = await doFetch(`${proxyOrigin}/${escaped}/@latest`);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: timedOut ? "go request timed out." : "go request failed.",
      };
    }

    if (response.status === 404 || response.status === 410) {
      return { status: "available", checkedAtMs: clock.nowMs() };
    }
    if (response.status === 429) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: "go rate limit exceeded.",
      };
    }
    if (response.status !== 200) {
      return {
        status: "unknown",
        checkedAtMs: clock.nowMs(),
        reason: `go responded with status ${response.status}.`,
      };
    }

    try {
      const payload: unknown = await response.json();
      const version = (payload as { Version?: unknown }).Version;
      if (typeof version === "string") {
        return { status: "taken", checkedAtMs: clock.nowMs() };
      }
    } catch {
      // fall through to ambiguous
    }
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      reason: "go returned an ambiguous response.",
    };
  }

  return {
    id: "go",
    validate(value: string): RegistryValidation {
      return normalizeGoName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      if (name.includes("/")) {
        return lookupQualified(name);
      }
      return lookupBare(name);
    },
  };
}

/** Extract module-path candidates from a pkg.go.dev search page. */
function extractModuleCandidates(html: string): string[] {
  const candidates: string[] = [];
  const hrefPattern = /href="\/([A-Za-z0-9!._~/-]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const path = match[1];
    if (!path) continue;
    const segments = path.split("/");
    const first = segments[0];
    if (segments.length >= 2 && first && first.includes(".")) {
      candidates.push(path);
    }
  }
  return candidates;
}
