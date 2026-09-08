import { describe, expect, it } from "vitest";
import {
  REGISTRY_LINEUP,
  registryById,
  normalizerFor,
  NPM_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  RUBYGEMS_DESCRIPTOR,
  HEX_DESCRIPTOR,
  MAVEN_DESCRIPTOR,
  GO_DESCRIPTOR,
  CRATES_DESCRIPTOR,
  NUGET_DESCRIPTOR,
  PACKAGIST_DESCRIPTOR,
  normalizeNpmName,
  normalizePypiName,
  normalizeHexName,
  normalizeRubygemsName,
  normalizeCratesName,
  normalizeNugetName,
  normalizeMavenName,
  normalizeGoName,
  normalizePackagistName,
  type RegistryDescriptor,
} from "../src/index.js";

const ALL_DESCRIPTORS = [
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

describe("REGISTRY_LINEUP", () => {
  it("contains exactly the nine venues in presentation order", () => {
    expect(REGISTRY_LINEUP.map((d) => d.id)).toEqual([
      "npm",
      "pypi",
      "rubygems",
      "hex",
      "maven",
      "go",
      "crates",
      "nuget",
      "packagist",
    ]);
  });

  it("is a readonly array of descriptors", () => {
    const lineup: readonly RegistryDescriptor[] = REGISTRY_LINEUP;
    expect(lineup).toHaveLength(9);
  });

  it("exposes every descriptor as a named export for import-path re-pointing", () => {
    const expected = [
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
    expected.forEach((descriptor) => {
      expect(descriptor).toBeDefined();
      expect(descriptor.id).toBeTruthy();
    });
  });
});

describe("descriptor completeness", () => {
  it("every venue exposes all descriptor fields with non-empty values", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(String(descriptor.id).length, descriptor.id).toBeGreaterThan(0);
      expect(String(descriptor.label).length, descriptor.id).toBeGreaterThan(0);
      expect(String(descriptor.language).length, descriptor.id).toBeGreaterThan(0);
      expect(["server", "browser"]).toContain(descriptor.venue);
      expect(typeof descriptor.classify, descriptor.id).toBe("function");
      expect(descriptor.checkUrl("demo"), descriptor.id).toBeTruthy();
      expect(descriptor.checkUrl("demo", "https://fake.test"), descriptor.id).toContain(
        "https://fake.test",
      );
      expect(String(descriptor.checkOrigin).length, descriptor.id).toBeGreaterThan(0);
      expect(descriptor.link("demo"), descriptor.id).toContain(encodeURIComponent("demo"));
      expect(descriptor.cacheTtl.availableMs).toBeGreaterThan(0);
      expect(descriptor.cacheTtl.takenMs).toBeGreaterThan(0);
    }
  });

  it("uses the universal 5-minute available / 24-hour taken cache TTL on every venue", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(descriptor.cacheTtl).toEqual({ availableMs: 300_000, takenMs: 86_400_000 });
    }
  });

  it("browser venues are exactly crates, nuget, packagist", () => {
    const browser = ALL_DESCRIPTORS.filter((d) => d.venue === "browser").map((d) => d.id);
    expect(browser).toEqual(["crates", "nuget", "packagist"]);
  });

  it("server venues carry a rateLimitPerMinute budget; browser venues omit it", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      if (descriptor.venue === "server") {
        expect(
          descriptor.rateLimitPerMinute,
          `${descriptor.id} should define rateLimitPerMinute`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          descriptor.rateLimitPerMinute,
          `${descriptor.id} should omit rateLimitPerMinute`,
        ).toBe(undefined);
      }
    }
  });

  it("does not populate userAgent on any descriptor (D7: browsers cannot set UA)", () => {
    for (const descriptor of ALL_DESCRIPTORS) {
      expect(descriptor.userAgent, descriptor.id).toBeUndefined();
    }
  });

  it("binds every venue's real core normalizer via normalize", () => {
    // Core is the single registry-knowledge source: web normalization must
    // equal adapter validation per venue (case, `/`, `:`, `_` rules).
    expect(normalizerFor(NPM_DESCRIPTOR)).toBe(normalizeNpmName);
    expect(normalizerFor(PYPI_DESCRIPTOR)).toBe(normalizePypiName);
    expect(normalizerFor(RUBYGEMS_DESCRIPTOR)).toBe(normalizeRubygemsName);
    expect(normalizerFor(HEX_DESCRIPTOR)).toBe(normalizeHexName);
    expect(normalizerFor(MAVEN_DESCRIPTOR)).toBe(normalizeMavenName);
    expect(normalizerFor(GO_DESCRIPTOR)).toBe(normalizeGoName);
    expect(normalizerFor(CRATES_DESCRIPTOR)).toBe(normalizeCratesName);
    expect(normalizerFor(NUGET_DESCRIPTOR)).toBe(normalizeNugetName);
    expect(normalizerFor(PACKAGIST_DESCRIPTOR)).toBe(normalizePackagistName);
  });
});

describe("registryById", () => {
  it("returns the matching descriptor for every known id", () => {
    for (const id of REGISTRY_LINEUP.map((d) => d.id)) {
      expect(registryById(id)?.id).toBe(id);
    }
  });

  it("returns undefined for an unsupported id", () => {
    expect(registryById("cocoapods")).toBeUndefined();
    expect(registryById("")).toBeUndefined();
  });
});

describe("normalizerFor", () => {
  it("applies a descriptor's own normalize override", () => {
    expect(normalizerFor(HEX_DESCRIPTOR)("Phoenix")).toEqual({ ok: true, name: "phoenix" });
    expect(normalizerFor(PYPI_DESCRIPTOR)("zope.interface")).toEqual({
      ok: true,
      name: "zope-interface",
    });
  });

  it("falls back to the default normalizer for descriptors without one", () => {
    const noNormalize: RegistryDescriptor = { ...GO_DESCRIPTOR, normalize: undefined };
    expect(normalizerFor(noNormalize)("  Back End  ")).toEqual({
      ok: true,
      name: "back-end",
    });
  });
});
