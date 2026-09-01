import type { RegistryDescriptor } from "./types";
import { classifyNotFound } from "./classify";

/** RubyGems registry descriptor (server venue). */
export const RUBYGEMS_DESCRIPTOR: RegistryDescriptor = {
  id: "rubygems",
  label: "RubyGems",
  language: "Ruby",
  venue: "server",
  classify: (input) => classifyNotFound(input),
  checkOrigin: "https://rubygems.org",
  checkUrl: (name, origin = "https://rubygems.org") =>
    `${origin}/api/v1/gems/${encodeURIComponent(name)}.json`,
  link: (name) => `https://rubygems.org/gems/${encodeURIComponent(name)}`,
  cacheTtl: { availableMs: 300_000, takenMs: 86_400_000 },
  rateLimitPerMinute: 30,
};
