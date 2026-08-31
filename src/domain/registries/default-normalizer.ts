import type { RegistryValidation } from "../ports";

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
