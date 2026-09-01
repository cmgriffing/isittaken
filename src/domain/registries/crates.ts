import type { RegistryDescriptor } from "./types";
import { classifyNotFound, isJsonObject } from "./classify";

/**
 * crates.io registry descriptor (browser venue: the API serves CORS headers
 * and expects user traffic). The `userAgent` identifies server-side checks
 * should the venue ever flip to "server".
 */
export const CRATES_DESCRIPTOR: RegistryDescriptor = {
  id: "crates",
  label: "crates.io",
  language: "Rust",
  venue: "browser",
  classify: (input) =>
    classifyNotFound(input, {
      shape: (json) => isJsonObject(json) && "crate" in json,
    }),
  checkOrigin: "https://crates.io",
  checkUrl: (name, origin = "https://crates.io") =>
    `${origin}/api/v1/crates/${encodeURIComponent(name)}`,
  link: (name) => `https://crates.io/crates/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  userAgent: "isittaken/0.1.0 (package name availability checker)",
};
