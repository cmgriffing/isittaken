import { NPM_DESCRIPTOR } from "./npm";
import { PYPI_DESCRIPTOR } from "./pypi";
import { RUBYGEMS_DESCRIPTOR } from "./rubygems";
import { HEX_DESCRIPTOR } from "./hex";
import { MAVEN_DESCRIPTOR } from "./maven";
import { CRATES_DESCRIPTOR } from "./crates";
import { NUGET_DESCRIPTOR } from "./nuget";
import { PACKAGIST_DESCRIPTOR } from "./packagist";
import type { LineupRegistryId, RegistryDescriptor } from "./types";
import { normalizeRegistryName } from "./default-normalizer";

export type {
  ClassifyInput,
  ClassificationStatus,
  LineupRegistryId,
  RegistryCacheTtl,
  RegistryClassification,
  RegistryDescriptor,
  RegistryVenue,
} from "./types";
export { REGISTRY_IDS } from "./types";
export { DEFAULT_MAX_NAME_LENGTH, normalizeRegistryName } from "./default-normalizer";
export { classifyExactMatch, classifyNotFound, isJsonArray, isJsonObject } from "./classify";

export { normalizeNpmName } from "./npm";
export { normalizePypiName } from "./pypi";
export { normalizeHexName } from "./hex";

export { NPM_DESCRIPTOR } from "./npm";
export { PYPI_DESCRIPTOR } from "./pypi";
export { RUBYGEMS_DESCRIPTOR } from "./rubygems";
export { HEX_DESCRIPTOR } from "./hex";
export { MAVEN_DESCRIPTOR } from "./maven";
export { CRATES_DESCRIPTOR } from "./crates";
export { NUGET_DESCRIPTOR } from "./nuget";
export { PACKAGIST_DESCRIPTOR } from "./packagist";

/**
 * The supported registry lineup, in presentation order: npm, PyPI, RubyGems,
 * Hex, and Maven run server-side (checked via /api/check); crates.io, NuGet,
 * and Packagist are fetched directly from the browser (CORS-enabled APIs).
 * Go (pkg.go.dev) is intentionally unsupported: no official JSON search API.
 */
export const REGISTRY_LINEUP: readonly RegistryDescriptor[] = [
  NPM_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  RUBYGEMS_DESCRIPTOR,
  HEX_DESCRIPTOR,
  MAVEN_DESCRIPTOR,
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
export function normalizerFor(
  descriptor: RegistryDescriptor,
): (raw: string) => ReturnType<typeof normalizeRegistryName> {
  return descriptor.normalize ?? normalizeRegistryName;
}

export type { RegistryId } from "../types";
export type { LineupRegistryId as LineupId };
