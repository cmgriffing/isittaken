import {
  VENUE_IDS,
  createCratesRegistry,
  createGoRegistry,
  createHexRegistry,
  createMavenRegistry,
  createNpmRegistry,
  createNugetRegistry,
  createPackagistRegistry,
  createPypiRegistry,
  createRubygemsRegistry,
  type Clock,
  type PackageRegistry,
  type VenueId,
} from "@isittaken/core";
import { CLI_VERSION } from "./version.js";
import { REPO_URL } from "./repo-info.js";

export interface CreateRegistriesOptions {
  timeoutMs: number;
  clock: Clock;
}

/**
 * Build the nine-venue adapters in canonical `VENUE_IDS` order for the
 * requested scope. Every adapter is stamped with the CLI version and repo URL
 * so upstream requests carry an identifiable User-Agent.
 */
export function createRegistries(
  ids: readonly VenueId[],
  options: CreateRegistriesOptions,
): PackageRegistry[] {
  const { timeoutMs, clock } = options;
  const base = { timeoutMs, clock, version: CLI_VERSION, repoUrl: REPO_URL };

  const byId: Record<VenueId, PackageRegistry> = {
    npm: createNpmRegistry({ ...base, origin: "https://registry.npmjs.org" }),
    pypi: createPypiRegistry({ ...base, origin: "https://pypi.org" }),
    crates: createCratesRegistry({ ...base, origin: "https://crates.io" }),
    rubygems: createRubygemsRegistry({ ...base, origin: "https://rubygems.org" }),
    nuget: createNugetRegistry({ ...base, origin: "https://api.nuget.org" }),
    hex: createHexRegistry({ ...base, origin: "https://hex.pm" }),
    maven: createMavenRegistry({
      ...base,
      searchOrigin: "https://search.maven.org",
      metadataOrigin: "https://repo1.maven.org",
    }),
    go: createGoRegistry({
      ...base,
      searchOrigin: "https://pkg.go.dev",
      proxyOrigin: "https://proxy.golang.org",
    }),
    packagist: createPackagistRegistry({
      ...base,
      searchOrigin: "https://packagist.org",
      p2Origin: "https://repo.packagist.org",
    }),
  };

  return VENUE_IDS.filter((id) => ids.includes(id)).map((id) => byId[id]);
}
