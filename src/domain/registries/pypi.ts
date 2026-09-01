import type { RegistryValidation } from "../ports";
import type { RegistryDescriptor } from "./types";
import { DEFAULT_MAX_NAME_LENGTH } from "./default-normalizer";
import { classifyNotFound } from "./classify";

/**
 * PyPI normalization per PEP 503: lowercase, and runs of `-`, `_`, and `.`
 * collapse to a single `-`, so `foo_bar` and `foo-bar` are the same project.
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
