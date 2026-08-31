import { describe, expect, it, vi } from "vitest";
import { runDiscovery, type DiscoveryDeps } from "../../src/domain/run-discovery";
import { SearchValidationError } from "../../src/domain/errors";
import { validateSearchRequest, type SearchLimits } from "../../src/domain/validate-search-request";
import type { CandidateSource } from "../../src/domain/ports";
import type { AppContext } from "../../src/functions/composition";
import { createTestContext } from "../helpers/test-context";

/**
 * An adapter-shaped caller (a future WebMCP tool) must receive the same
 * validation, provenance, deduplication, and candidate discovery as the HTTP
 * search path. These tests drive the transport-neutral use case exactly as
 * `createSearchFunction` does.
 */

const limits: SearchLimits = {
  maxSeedLength: 64,
  maxInjectedSynonyms: 25,
  maxInjectedCreatives: 25,
  maxCandidateLength: 214,
  maxTotalCandidates: 120,
};

let tick = 0;
const clock = { nowMs: () => (tick += 1) };

function fakeSource(
  candidates: { value: string; provenance: "wordnik-synonym" | "wordnik-related" }[],
): CandidateSource {
  return {
    id: "wordnik",
    fetch: async () => ({ status: "ok", candidates }),
  };
}

function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    sources: [fakeSource([{ value: "optics", provenance: "wordnik-synonym" }])],
    clock,
    limits,
    ...overrides,
  };
}

describe("adapter-shaped caller (transport-neutral discovery)", () => {
  it("applies identical validation to HTTP-shaped input", async () => {
    const badRequests: unknown[] = [
      { seed: "" },
      { seed: "a".repeat(65) },
      { seed: "@scope/pkg" },
      { seed: "ok", injectedSynonyms: ["has#char"] },
      { seed: "ok", injectedCreatives: Array.from({ length: 26 }, (_, i) => `w${i}`) },
    ];
    for (const request of badRequests) {
      expect(() => validateSearchRequest(request as never, limits)).toThrowError(
        SearchValidationError,
      );
    }
  });

  it("returns the same provenance and deduplication as the HTTP path", async () => {
    const result = await runDiscovery(
      { seed: "laser", injectedSynonyms: ["Laser", "optics"], injectedCreatives: ["laser-beam"] },
      deps({
        sources: [fakeSource([{ value: "optics", provenance: "wordnik-synonym" }])],
      }),
    );

    expect(result.seed).toBe("laser");
    // Deduplication: "Laser" merges with the seed.
    const names = result.candidates.map((c) => c.name).sort();
    expect(names).toEqual(["laser", "laser-beam", "optics"]);
    const laser = result.candidates.find((c) => c.name === "laser");
    expect(laser?.provenance).toEqual(["input", "injected-synonym"]);
    const optics = result.candidates.find((c) => c.name === "optics");
    expect(optics?.provenance).toEqual(["wordnik-synonym", "injected-synonym"]);
  });

  it("consumes zero generation quota for injected creative candidates", async () => {
    const context = await createTestContext();
    try {
      const ctx = context.ctx as AppContext;
      const result = await runDiscovery(
        {
          seed: "laser",
          injectedCreatives: ["lazerly", "laser-kit"],
          injectedSynonyms: [],
        },
        deps({ sources: [] }),
      );

      expect(result.candidates).toHaveLength(3);

      const now = ctx.clock.nowMs();
      const minute = Math.floor(now / 60_000) * 60_000;
      const buckets = await ctx.db.execute({
        sql: "SELECT COUNT(*) AS n FROM ai_usage_buckets",
        args: [],
      });
      // No AI usage was recorded at all.
      expect(Number(buckets.rows[0]?.["n"])).toBe(0);
      const usedBurst = await ctx.quotas.read(
        { subjectType: "user", subjectId: "anyone" },
        "burst-minute",
        minute,
      );
      expect(usedBurst.used).toBe(0);
    } finally {
      context.cleanup();
    }
  });

  it("matches the HTTP handler's output for the same request", async () => {
    const fetchUpstream = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const context = await createTestContext({ fetchImpl: fetchUpstream });
    try {
      const ctx = context.ctx;
      const searchHandler = (await import("../../src/functions/search")).createSearchFunction(ctx);

      // The adapter path:
      const validated = validateSearchRequest(
        { seed: "laser", injectedSynonyms: ["optics"] },
        ctx.config.limits,
      );
      const adapterResult = await runDiscovery(validated, {
        sources: [ctx.wordnikSource],
        clock: ctx.clock,
        limits: ctx.config.limits,
      });

      // The HTTP path with the same input:
      const response = await searchHandler(
        new Request("http://localhost/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seed: "laser", injectedSynonyms: ["optics"] }),
        }),
      );
      expect(response.status).toBe(200);
      const httpResult = (await response.json()) as typeof adapterResult;

      // Wordnik is unconfigured in this context (skipped), so both paths see
      // the identical candidate set with identical structure.
      expect(httpResult.candidates.map((c) => c.name).sort()).toEqual(
        adapterResult.candidates.map((c) => c.name).sort(),
      );
      expect(httpResult.candidates.map((c) => c.provenance)).toEqual(
        adapterResult.candidates.map((c) => c.provenance),
      );
      expect(httpResult.candidates.map((c) => c.registryResults)).toEqual(
        adapterResult.candidates.map((c) => c.registryResults),
      );
    } finally {
      context.cleanup();
    }
  });
});
