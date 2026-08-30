import { describe, expect, it } from "vitest";
import { runDiscovery, type DiscoveryDeps } from "../../../src/domain/run-discovery";
import type {
  CandidateSource,
  PackageRegistry,
  RegistryValidation,
} from "../../../src/domain/ports";
import type { RegistryLookupResult } from "../../../src/domain/types";
import type { SearchLimits } from "../../../src/domain/validate-search-request";

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
    registries: [fakeRegistry()],
    clock,
    limits,
    registryConcurrency: 4,
    ...overrides,
  };
}

describe("runDiscovery", () => {
  it("always includes the seed as an input candidate", async () => {
    const response = await runDiscovery({ seed: "laser" }, deps());
    expect(response.seed).toBe("laser");
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.name).toBe("laser");
    expect(response.candidates[0]?.provenance).toEqual(["input"]);
  });

  it("still checks seed and injected candidates when every source fails", async () => {
    const lookups: string[] = [];
    const response = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["optics"] },
      deps({
        sources: [
          fakeSource({
            fetch: async () => ({ status: "unavailable", reason: "wordnik down" }),
          }),
        ],
        registries: [
          fakeRegistry({
            lookup: async (name) => {
              lookups.push(name);
              return { status: "available", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
      }),
    );

    expect(lookups.sort()).toEqual(["laser", "optics"]);
    expect(response.sources).toEqual([
      { source: "wordnik", status: "unavailable", reason: "wordnik down" },
    ]);
    expect(response.candidates).toHaveLength(2);
  });

  it("sluggifies multi-word synonyms at the registry boundary with a shared lookup", async () => {
    const lookups: string[] = [];
    const response = await runDiscovery(
      // "back end" (Wordnik phrase) and "back-end" (injected) are distinct
      // domain identities but must share one npm lookup for the same slug.
      { seed: "backend", injectedSynonyms: ["back-end"] },
      deps({
        sources: [
          fakeSource({
            fetch: async () => ({
              status: "ok",
              candidates: [{ value: "back end", provenance: "wordnik-synonym" }],
            }),
          }),
        ],
        registries: [
          fakeRegistry({
            validate: (value: string): RegistryValidation =>
              /^[a-z0-9][a-z0-9\-.]*$/.test(value.replace(/\s+/g, "-"))
                ? { ok: true, name: value.trim().replace(/\s+/g, "-").toLowerCase() }
                : { ok: false, reason: "invalid npm name" },
            lookup: async (name) => {
              lookups.push(name);
              return { status: "taken", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
      }),
    );

    // Three candidates ("backend", "back end", "back-end"), two unique
    // npm slugs — the phrase and the hyphenated form share one lookup.
    expect(lookups.sort()).toEqual(["back-end", "backend"]);
    const phrase = response.candidates.find((c) => c.name === "back end");
    expect(phrase?.registryResults[0]).toMatchObject({
      name: "back-end",
      status: "taken",
    });
    const slug = response.candidates.find((c) => c.name === "back-end");
    expect(slug?.registryResults[0]).toMatchObject({ name: "back-end", status: "taken" });
  });

  it("merges duplicate provenance and performs a single lookup", async () => {
    const lookups: string[] = [];
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
        registries: [
          fakeRegistry({
            lookup: async (name) => {
              lookups.push(name);
              return { status: "taken", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
      }),
    );

    expect(lookups).toEqual(["laser"]);
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.provenance).toEqual([
      "input",
      "wordnik-synonym",
      "injected-synonym",
    ]);
  });

  it("classifies registry-invalid candidates without looking them up", async () => {
    const lookups: string[] = [];
    const response = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["has space", "ok-name"] },
      deps({
        registries: [
          fakeRegistry({
            lookup: async (name) => {
              lookups.push(name);
              return { status: "available", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
      }),
    );

    expect(lookups).toEqual(["laser", "ok-name"]);
    const invalid = response.candidates.find((c) => c.name === "has space");
    expect(invalid?.registryResults[0]?.status).toBe("invalid");
    expect(invalid?.registryResults[0]?.reason).toMatch(/invalid npm name/);
  });

  it("maps throwing registry lookups to unknown, never available", async () => {
    const response = await runDiscovery(
      { seed: "laser" },
      deps({
        registries: [
          fakeRegistry({
            lookup: async () => {
              throw new Error("boom");
            },
          }),
        ],
      }),
    );
    const result = response.candidates[0]?.registryResults[0];
    expect(result?.status).toBe("unknown");
    expect(result?.reason).toBe("boom");
  });

  it("bounds concurrent registry lookups", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seedWords = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const response = await runDiscovery(
      { seed: "seed", injectedSynonyms: seedWords },
      deps({
        registryConcurrency: 3,
        registries: [
          fakeRegistry({
            lookup: async (_name) => {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 5));
              inFlight -= 1;
              return { status: "available", checkedAtMs: clock.nowMs() };
            },
          }),
        ],
      }),
    );

    expect(response.candidates).toHaveLength(13);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("reports successful sources as ok and composes registry results", async () => {
    const response = await runDiscovery(
      { seed: "laser", injectedCreatives: ["lazerly"] },
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
    expect(response.candidates.map((c) => c.name)).toEqual([
      "laser",
      "optics",
      "photon",
      "lazerly",
    ]);
    for (const candidate of response.candidates) {
      expect(candidate.registryResults[0]?.status).toBe("taken");
      expect(candidate.registryResults[0]?.registry).toBe("npm");
      expect(typeof candidate.registryResults[0]?.checkedAtMs).toBe("number");
    }
  });
});
