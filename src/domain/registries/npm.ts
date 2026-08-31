import type { RegistryValidation } from "../ports";
import type { RegistryDescriptor } from "./types";
import { DEFAULT_MAX_NAME_LENGTH } from "./default-normalizer";
import { classifyNotFound } from "./classify";

/**
 * npm unscoped-name normalization. Scoped names are explicitly unsupported
 * and rejected with a dedicated reason.
 */
export function normalizeNpmName(value: string): RegistryValidation {
  const collapsed = value.trim().replace(/\s+/g, "-").toLowerCase();
  if (collapsed.length === 0) {
    return { ok: false, reason: "Name is empty." };
  }
  if (collapsed.includes("/")) {
    return { ok: false, reason: "Scoped npm names are not supported." };
  }
  if (collapsed.length > DEFAULT_MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds npm's ${DEFAULT_MAX_NAME_LENGTH}-character limit.`,
    };
  }
  if (!/^[a-z0-9]/.test(collapsed)) {
    return { ok: false, reason: "Name must start with a letter or digit." };
  }
  if (!/^[a-z0-9\-._]+$/.test(collapsed)) {
    return { ok: false, reason: "Name contains characters npm does not allow." };
  }
  if (collapsed.startsWith(".") || collapsed.startsWith("_")) {
    return { ok: false, reason: "Name cannot start with a dot or underscore." };
  }
  if (collapsed.endsWith("-")) {
    return { ok: false, reason: "Name cannot end with a hyphen." };
  }
  return { ok: true, name: collapsed };
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
