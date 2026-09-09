import type { Clock, PackageRegistry, RegistryValidation } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import { createRegistryFetch, type RegistryFetch } from "../registry-http.js";
import { lookupPresence } from "./presence.js";
import { classifyNotFound, DEFAULT_MAX_NAME_LENGTH } from "../classify.js";
import type { RegistryDescriptor } from "../descriptors.js";

export interface PypiRegistryOptions {
  /** Fixed registry origin; callers cannot override it per request. */
  origin: string;
  timeoutMs: number;
  clock: Clock;
  /** App-supplied version for the User-Agent (never hardcoded in core). */
  version: string;
  repoUrl: string;
  fetchImpl?: typeof fetch;
  /** Full User-Agent override. */
  userAgent?: string;
}

/**
 * PyPI (PEP 503) normalization — the upstream rule: lowercase, and runs of
 * `-`, `_`, `.`, and whitespace collapse to a single hyphen, so "back end"
 * and "back-end" are the same project. A name must begin and end with a
 * letter or digit. Names that could not be published are rejected with a
 * reason.
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

/**
 * PyPI registry adapter. Exact venue: 200 with a parseable project payload is
 * taken, the documented 404 is available, and every ambiguous response is
 * unknown.
 */
export function createPypiRegistry(options: PypiRegistryOptions): PackageRegistry {
  const { origin, clock } = options;
  const doFetch: RegistryFetch = createRegistryFetch({
    version: options.version,
    repoUrl: options.repoUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
  });

  return {
    id: "pypi",
    validate(value: string): RegistryValidation {
      return normalizePypiName(value);
    },
    async lookup(name: string): Promise<RegistryLookupResult> {
      return lookupPresence(`${origin}/pypi/${encodeURIComponent(name)}/json`, {
        venue: "pypi",
        fetch: doFetch,
        clock,
      });
    },
  };
}

/**
 * PyPI registry descriptor (server venue). Names normalize per PEP 503 and
 * classify via the shared not-found predicate.
 */
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
