import { describe, expect, it } from "vitest";
import {
  runDiscovery,
  checkCandidatesAcrossRegistries,
  type DiscoveryDeps,
} from "../src/run-discovery.js";
import type { CandidateSource, PackageRegistry, RegistryValidation } from "../src/ports.js";
import type { RegistryLookupResult } from "../src/types.js";
import type { SearchLimits } from "../src/validate-search-request.js";

const limits: SearchLimits = {
  maxSeedLength: 32,
  maxInjectedSynonyms: 5,
  maxInjectedCreatives: 5,
  maxCandidateLength: 64,
  maxTotalCandidates: 20,
};

let tick = 0;
const clock = { nowMs: () => (tick += 1) };

function fakeSource(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    id: "wordnik",
    fetch: async () => ({ status: "unavailable", reason: "disabled" }),
    ...overrides,
  } as CandidateSource;
}

function fakeRegistry(overrides: Partial<PackageRegistry> = {}): PackageRegistry {
  return {
    id: "npm",
    validate: (value: string): RegistryValidation =>
      /^[a-z0-9][a-z0-9\-.]*$/.test(value)
        ? { ok: true, name: value }
        : { ok: false, reason: `invalid npm name: ${value}` },
    lookup: async (_name: string): Promise<RegistryLookupResult> => ({
      status: "taken",
      checkedAtMs: clock.nowMs(),
    }),
    ...overrides,
  } as PackageRegistry;
}

function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    sources: [],
    clock,
    limits,
    ...overrides,
  };
}

describe("runDiscovery (candidate discovery only)", () => {
  it("always includes the seed as an input candidate", async () => {
    const response = await runDiscovery({ seed: "laser" }, deps());
    expect(response.seed).toBe("laser");
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.name).toBe("laser");
    expect(response.candidates[0]?.provenance).toEqual(["input"]);
    // No registry work happens at discovery time.
    expect(response.candidates[0]?.registryResults).toEqual([]);
  });

  it("still composes seed and injected candidates when every source fails", async () => {
    const response = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["optics"] },
      deps({
        sources: [
          fakeSource({
            fetch: async () => ({ status: "unavailable", reason: "wordnik down" }),
          }),
        ],
      }),
    );

    expect(response.sources).toEqual([
      { source: "wordnik", status: "unavailable", reason: "wordnik down" },
    ]);
    expect(response.candidates.map((c) => c.name).sort()).toEqual(["laser", "optics"]);
  });

  it("collects source candidates with their provenance", async () => {
    const response = await runDiscovery(
      { seed: "laser" },
      deps({
        sources: [
          fakeSource({
            fetch: async () => ({
              status: "ok",
              candidates: [
                { value: "optics", provenance: "wordnik-synonym" },
                { value: "photon", provenance: "wordnik-related" },
              ],
            }),
          }),
        ],
      }),
    );

    expect(response.sources).toEqual([{ source: "wordnik", status: "ok" }]);
    expect(response.candidates.map((c) => c.name)).toEqual(["laser", "optics", "photon"]);
    expect(response.candidates[1]?.provenance).toEqual(["wordnik-synonym"]);
  });

  it("merges duplicate candidates and unions provenance in first-seen order", async () => {
    const response = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["Laser", " laser "] },
      deps({
        sources: [
          fakeSource({
            fetch: async () => ({
              status: "ok",
              candidates: [{ value: "laser", provenance: "wordnik-synonym" }],
            }),
          }),
        ],
      }),
    );

    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.provenance).toEqual([
      "input",
      "wordnik-synonym",
      "injected-synonym",
    ]);
  });

  it("applies candidate limits and drops oversized values", async () => {
    const response = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["o".repeat(80), "ok"] },
      deps(),
    );
    expect(response.candidates.map((c) => c.name)).toEqual(["laser", "ok"]);
  });

  it("caps the total candidate count at the configured limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `word-${i}`);
    const response = await runDiscovery({ seed: "seed", injectedSynonyms: many }, deps());
    expect(response.candidates).toHaveLength(20);
  });
});

describe("checkCandidatesAcrossRegistries (exported primitive)", () => {
  it("returns per-candidate registry results in input order", async () => {
    const lookups: string[] = [];
    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "laser" }, { normalized: "optics" }],
      {
        registries: [
          fakeRegistry({
            lookup: async (name) => {
              lookups.push(name);
              return { status: "available", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
        clock,
        registryConcurrency: 2,
      },
    );

    expect(lookups).toEqual(["laser", "optics"]);
    expect(results).toHaveLength(2);
    expect(results[0]?.[0]).toMatchObject({ registry: "npm", name: "laser", status: "available" });
    expect(results[1]?.[0]).toMatchObject({ registry: "npm", name: "optics", status: "available" });
  });

  it("classifies invalid candidates without a lookup and maps throws to unknown", async () => {
    const lookups: string[] = [];
    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "has space" }, { normalized: "ok-name" }],
      {
        registries: [
          fakeRegistry({
            lookup: async (name) => {
              lookups.push(name);
              if (name === "ok-name") throw new Error("boom");
              return { status: "available", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
        clock,
        registryConcurrency: 2,
      },
    );

    expect(lookups).toEqual(["ok-name"]);
    expect(results[0]?.[0]?.status).toBe("invalid");
    expect(results[1]?.[0]?.status).toBe("unknown");
    expect(results[1]?.[0]?.reason).toBe("boom");
  });
});
