import { describe, expect, it, vi } from "vitest";
import { checkCandidatesAcrossRegistries } from "../src/run-discovery.js";
import { createNpmRegistry } from "../src/registries/npm.js";
import { createPypiRegistry } from "../src/registries/pypi.js";
import { createCratesRegistry } from "../src/registries/crates.js";
import { createRubygemsRegistry } from "../src/registries/rubygems.js";
import { createNugetRegistry } from "../src/registries/nuget.js";
import { createHexRegistry } from "../src/registries/hex.js";
import type { PackageRegistry } from "../src/ports.js";

const clock = { nowMs: () => 1_000 };

/** A fetch that records every URL and returns a fresh canned 200 JSON body per call. */
function recordingFetch(body: unknown, status = 200) {
  const fetchImpl = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  return fetchImpl;
}

function baseVenueOptions(origin: string, fetchImpl: typeof fetch) {
  return {
    origin,
    timeoutMs: 1_000,
    clock,
    version: "1.2.3",
    repoUrl: "https://example.test/repo",
    fetchImpl,
  };
}

describe("checkCandidatesAcrossRegistries with real adapters", () => {
  it("runs a multi-venue check where every candidate gets every venue's result", async () => {
    const registries: PackageRegistry[] = [
      createNpmRegistry(baseVenueOptions("https://npm.test", recordingFetch({ "dist-tags": {} }))),
      createPypiRegistry(baseVenueOptions("https://pypi.test", recordingFetch({ info: {} }))),
      createCratesRegistry(baseVenueOptions("https://crates.test", recordingFetch({ crate: {} }))),
      createRubygemsRegistry(
        baseVenueOptions("https://rubygems.test", recordingFetch({ name: "laser" })),
      ),
      createNugetRegistry(
        baseVenueOptions("https://nuget.test", recordingFetch({ versions: ["1.0.0"] })),
      ),
      createHexRegistry(baseVenueOptions("https://hex.test", recordingFetch({ name: "laser" }))),
    ];

    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "laser" }, { normalized: "optics" }],
      { registries, clock, registryConcurrency: 4 },
    );

    expect(results).toHaveLength(2);
    for (const candidate of results) {
      expect(candidate).toHaveLength(6);
      expect(candidate.map((r) => r.registry)).toEqual([
        "npm",
        "pypi",
        "crates",
        "rubygems",
        "nuget",
        "hex",
      ]);
      for (const result of candidate) {
        expect(result.status).toBe("taken");
      }
    }
  });

  it("dedupes crates underscore/hyphen equivalence to a single lookup", async () => {
    const fetchImpl = recordingFetch({ crate: { name: "foo-bar" } });
    const crates = createCratesRegistry(baseVenueOptions("https://crates.test", fetchImpl));

    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "foo_bar" }, { normalized: "foo-bar" }],
      { registries: [crates], clock, registryConcurrency: 2 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://crates.test/api/v1/crates/foo-bar",
      expect.anything(),
    );
    expect(results[0]?.[0]).toMatchObject({ name: "foo-bar", status: "taken" });
    expect(results[1]?.[0]).toMatchObject({ name: "foo-bar", status: "taken" });
  });

  it("dedupes pypi separator runs to a single lookup", async () => {
    const fetchImpl = recordingFetch({ info: { name: "fuzzy-picker" } });
    const pypi = createPypiRegistry(baseVenueOptions("https://pypi.test", fetchImpl));

    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "Fuzzy_Picker" }, { normalized: "fuzzy-picker" }],
      { registries: [pypi], clock, registryConcurrency: 2 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pypi.test/pypi/fuzzy-picker/json",
      expect.anything(),
    );
    expect(results[0]?.[0]).toMatchObject({ name: "fuzzy-picker", status: "taken" });
    expect(results[1]?.[0]).toMatchObject({ name: "fuzzy-picker", status: "taken" });
  });

  it("isolates a failing venue so other venues still complete", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const okFetch = recordingFetch({ info: {} });

    const registries: PackageRegistry[] = [
      createPypiRegistry(baseVenueOptions("https://pypi.test", failingFetch)),
      createNpmRegistry(baseVenueOptions("https://npm.test", okFetch)),
    ];

    const results = await checkCandidatesAcrossRegistries([{ normalized: "laser" }], {
      registries,
      clock,
      registryConcurrency: 2,
    });

    const pypi = results[0]?.[0];
    const npm = results[0]?.[1];
    expect(pypi?.registry).toBe("pypi");
    expect(pypi?.status).toBe("unknown");
    expect(pypi?.reason).toMatch(/failed/);
    expect(npm?.registry).toBe("npm");
    expect(npm?.status).toBe("taken");
  });

  it("classifies invalid names without network while other names still resolve", async () => {
    const fetchImpl = recordingFetch({ "dist-tags": {} });
    const npm = createNpmRegistry(baseVenueOptions("https://npm.test", fetchImpl));

    const results = await checkCandidatesAcrossRegistries(
      [{ normalized: "foo/bar" }, { normalized: "laser" }],
      { registries: [npm], clock, registryConcurrency: 2 },
    );

    // Only the valid name is looked up; the invalid one never touches the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://npm.test/laser", expect.anything());

    const invalid = results[0]?.[0];
    expect(invalid?.status).toBe("invalid");
    expect(invalid?.reason).toMatch(/not supported/);

    const valid = results[1]?.[0];
    expect(valid?.status).toBe("taken");
  });
});
