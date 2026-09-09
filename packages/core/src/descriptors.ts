import type { RegistryId } from "./types.js";
import type { RegistryValidation } from "./ports.js";
import type { ClassifyInput, RegistryClassification } from "./classify.js";
import { normalizeRegistryName } from "./classify.js";

import { NPM_DESCRIPTOR } from "./registries/npm.js";
import { PYPI_DESCRIPTOR } from "./registries/pypi.js";
import { RUBYGEMS_DESCRIPTOR } from "./registries/rubygems.js";
import { HEX_DESCRIPTOR } from "./registries/hex.js";
import { MAVEN_DESCRIPTOR } from "./registries/maven.js";
import { GO_DESCRIPTOR } from "./registries/go.js";
import { CRATES_DESCRIPTOR } from "./registries/crates.js";
import { NUGET_DESCRIPTOR } from "./registries/nuget.js";
import { PACKAGIST_DESCRIPTOR } from "./registries/packagist.js";

/** Where a registry's availability check executes. */
export type RegistryVenue = "server" | "browser";

/**
 * Per-verdict cache freshness for the registry's verdicts. Available names
 * can become taken at any moment, so `availableMs` is always the shorter TTL.
 */
export interface RegistryCacheTtl {
  availableMs: number;
  takenMs: number;
}

export interface RegistryDescriptor {
  /** Stable identifier used in cache keys, the check API, and the UI. */
  id: RegistryId;
  /** Human label, e.g. "crates.io". */
  label: string;
  /** Primary language/ecosystem, e.g. "Rust". */
  language: string;
  /** `server`: checked via /api/check. `browser`: fetched from the client. */
  venue: RegistryVenue;
  /**
   * Registry-specific normalization + validation. Absent: the default
   * normalizer applies (trim, whitespace runs to `-`, lowercase).
   */
  normalize?: (raw: string) => RegistryValidation;
  /**
   * Map an upstream (status, body shape) to a verdict. Must be conservative:
   * ambiguity classifies as `unknown`, never `available`.
   */
  classify: (input: ClassifyInput) => RegistryClassification;
  /**
   * Public JSON endpoint that answers "does this normalized name exist?".
   * `origin` defaults to the descriptor's `checkOrigin`; the server adapter
   * passes its configured origin so tests can point at fakes.
   */
  checkUrl: (name: string, origin?: string) => string;
  /** Canonical check-endpoint origin, e.g. "https://pypi.org". */
  checkOrigin: string;
  /** Canonical package URL for a registry name (client-safe link builder). */
  link: (name: string) => string;
  cacheTtl: RegistryCacheTtl;
  /** Per-IP, per-minute server-side check budget (server venue only). */
  rateLimitPerMinute?: number;
  /** Identifying User-Agent required by some upstreams. */
  userAgent?: string;
}

/**
 * The supported registry lineup, in presentation order. `@isittaken/core` is
 * the single source of registry knowledge: this lineup and `registryById` are
 * the only enumerations the web app and CLI need.
 */
export const REGISTRY_LINEUP: readonly RegistryDescriptor[] = [
  NPM_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  RUBYGEMS_DESCRIPTOR,
  HEX_DESCRIPTOR,
  MAVEN_DESCRIPTOR,
  GO_DESCRIPTOR,
  CRATES_DESCRIPTOR,
  NUGET_DESCRIPTOR,
  PACKAGIST_DESCRIPTOR,
];

/** Look up a descriptor by registry id, or undefined when unsupported. */
export function registryById(id: string): RegistryDescriptor | undefined {
  return REGISTRY_LINEUP.find((descriptor) => descriptor.id === id);
}

/**
 * The normalizer a descriptor applies: its own override, or the shared
 * default (trim, whitespace runs to `-`, lowercase) with validation.
 */
export function normalizerFor(descriptor: RegistryDescriptor): (raw: string) => RegistryValidation {
  return descriptor.normalize ?? normalizeRegistryName;
}
