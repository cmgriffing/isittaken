/**
 * @isittaken/core — transport-neutral package-name availability domain.
 *
 * Shared by the web app and the CLI. Nothing here imports Astro, Netlify,
 * Preact, a database, or any web-only provider; adapters and repositories
 * live in the calling application.
 */

// Types
export type {
  RegistryId,
  RegistryStatus,
  RegistryLookupResult,
  RegistryResult,
  Candidate,
  ComposedCandidate,
  SearchResponse,
  SourceOutcome,
  SourceId,
  SourceStatus,
  ProvenanceKind,
} from "./types.js";
export { PROVENANCE_KINDS, PROVENANCE_KIND_VALUES, REGISTRY_STATUS_VALUES } from "./types.js";

// Ports
export type {
  Clock,
  RawCandidate,
  CandidateSource,
  CandidateSourceResult,
  PackageRegistry,
  RegistryValidation,
} from "./ports.js";

// Errors
export { SearchValidationError } from "./errors.js";
export type { SearchValidationCode } from "./errors.js";

// Candidate normalization
export { normalizeCandidateValue, normalizeAndDedupeCandidates } from "./normalize-candidates.js";
export type { NormalizeOptions } from "./normalize-candidates.js";

// Search request validation
export { validateSearchRequest } from "./validate-search-request.js";
export type {
  SearchRequest,
  SearchLimits,
  ValidatedSearchRequest,
} from "./validate-search-request.js";

// Discovery pipeline
export { runDiscovery, checkCandidatesAcrossRegistries } from "./run-discovery.js";
export type { DiscoveryInput, DiscoveryDeps, CheckAcrossRegistriesDeps } from "./run-discovery.js";

// Versioned cache-value envelope
export { encodeVersionedValue, decodeVersionedValue } from "./cache-value.js";

// Concurrency helper
export { mapWithConcurrency } from "./concurrency.js";

// Shared registry fetch helper
export { createRegistryFetch } from "./registry-http.js";
export type { RegistryFetchOptions, RegistryFetch } from "./registry-http.js";

// Venue catalog
export { VENUE_IDS, isVenueId } from "./venues.js";
export type { VenueId } from "./venues.js";

// Shared presence-classification template
export { lookupPresence } from "./registries/presence.js";
export type { PresenceLookupOptions } from "./registries/presence.js";

// Registry descriptor surface (single source of registry knowledge)
export type { RegistryVenue, RegistryCacheTtl, RegistryDescriptor } from "./descriptors.js";
export { REGISTRY_LINEUP, registryById, normalizerFor } from "./descriptors.js";

// Shared classification helpers
export type { ClassificationStatus, ClassifyInput, RegistryClassification } from "./classify.js";
export {
  normalizeRegistryName,
  DEFAULT_MAX_NAME_LENGTH,
  isJsonObject,
  isJsonArray,
  classifyNotFound,
  classifyExactMatch,
} from "./classify.js";

// Registry descriptors
export { NPM_DESCRIPTOR } from "./registries/npm.js";
export { PYPI_DESCRIPTOR } from "./registries/pypi.js";
export { RUBYGEMS_DESCRIPTOR } from "./registries/rubygems.js";
export { HEX_DESCRIPTOR } from "./registries/hex.js";
export { MAVEN_DESCRIPTOR } from "./registries/maven.js";
export { GO_DESCRIPTOR } from "./registries/go.js";
export { CRATES_DESCRIPTOR, hasCratesCrate } from "./registries/crates.js";
export { NUGET_DESCRIPTOR, hasNugetVersions } from "./registries/nuget.js";
export { PACKAGIST_DESCRIPTOR } from "./registries/packagist.js";

// npm registry adapter
export { createNpmRegistry, normalizeNpmName } from "./registries/npm.js";
export type { NpmRegistryOptions } from "./registries/npm.js";

// pypi registry adapter
export { createPypiRegistry, normalizePypiName } from "./registries/pypi.js";
export type { PypiRegistryOptions } from "./registries/pypi.js";

// crates registry adapter
export { createCratesRegistry, normalizeCratesName } from "./registries/crates.js";
export type { CratesRegistryOptions } from "./registries/crates.js";

// rubygems registry adapter
export { createRubygemsRegistry, normalizeRubygemsName } from "./registries/rubygems.js";
export type { RubygemsRegistryOptions } from "./registries/rubygems.js";

// nuget registry adapter
export { createNugetRegistry, normalizeNugetName } from "./registries/nuget.js";
export type { NugetRegistryOptions } from "./registries/nuget.js";

// hex registry adapter
export { createHexRegistry, normalizeHexName } from "./registries/hex.js";
export type { HexRegistryOptions } from "./registries/hex.js";

// packagist registry adapter
export { createPackagistRegistry, normalizePackagistName } from "./registries/packagist.js";
export type { PackagistRegistryOptions } from "./registries/packagist.js";

// maven registry adapter
export { createMavenRegistry, normalizeMavenName } from "./registries/maven.js";
export type { MavenRegistryOptions } from "./registries/maven.js";

// go registry adapter
export { createGoRegistry, normalizeGoName } from "./registries/go.js";
export type { GoRegistryOptions } from "./registries/go.js";
