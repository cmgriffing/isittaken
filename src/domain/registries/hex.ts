import type { RegistryValidation } from "../ports";
import type { RegistryDescriptor } from "./types";
import { DEFAULT_MAX_NAME_LENGTH } from "./default-normalizer";
import { classifyNotFound } from "./classify";

/** Hex normalization: package names are lowercase. */
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
