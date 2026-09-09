// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWebMcpAdapter } from "../../../../../src/lib/client/webmcp/adapter";
import type { RegisteredToolLike } from "./helpers";

/**
 * Store integration: tool calls drive island-visible state through the
 * shared store — candidates, selection, progress — and resolve only after
 * the fan-out settles. Injected candidates carry provenance without
 * touching OpenRouter.
 */

type FetchMock = ReturnType<typeof vi.fn>;

async function setup(fetchImpl: FetchMock) {
  const { createSearchStore, resetSearchStoreForTests } =
    await import("../../../../../src/lib/client/search-store");
  resetSearchStoreForTests();
  const store = createSearchStore({ fetchImpl: fetchImpl as unknown as typeof fetch });
  vi.stubGlobal("fetch", fetchImpl);
  const registered: RegisteredToolLike[] = [];
  const adapter = createWebMcpAdapter({
    store,
    getModelContext: () => ({
      registerTool: (tool: RegisteredToolLike) => {
        registered.push(tool);
      },
    }),
  });
  adapter.register();
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return { store, byName, fetchImpl };
}

function searchResponse() {
  return {
    seed: "laser",
    generatedAtMs: Date.now(),
    sources: [{ source: "wordnik", status: "ok" }],
    candidates: [
      { name: "laser", provenance: ["input"], registryResults: [] },
      { name: "optics", provenance: ["wordnik-synonym"], registryResults: [] },
    ],
  };
}

describe("batch drives island-visible state", () => {
  it("populates candidates, selection, and progress; resolves after fan-out", async () => {
    let gateRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateRelease = resolve;
    });
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      await gate;
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    const { store, byName } = await setup(fetchImpl as never);
    const batch = byName.get("batch_check_availability") as RegisteredToolLike;

    let resolved = false;
    const pending = (
      batch.execute({ seed: "laser", registries: ["npm", "pypi"] }, {}) as Promise<unknown>
    ).then((value) => {
      resolved = true;
      return value;
    });

    // While in flight: candidates + selection are live in the store.
    await vi.waitFor(() => expect(store.getState().candidates.length).toBeGreaterThan(0));
    expect(store.getState().selectedIds).toEqual(["npm", "pypi"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(store.getProgress()).not.toBeNull();

    gateRelease();
    const result = (await pending) as {
      verdicts: unknown[];
      selectionUsed: string[];
    };
    expect(resolved).toBe(true);
    // Only resolves after the full fan-out: all checks fetched.
    const checkCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/api/check"));
    expect(checkCalls.length).toBeGreaterThanOrEqual(4); // 2 candidates x 2 registries
    expect(result.verdicts.length).toBeGreaterThanOrEqual(4);
    expect(result.selectionUsed).toEqual(["npm", "pypi"]);
    expect(store.getProgress()).toBeNull();
  });

  it("injected candidates produce injected-* provenance with no OpenRouter route", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(
          JSON.stringify({
            seed: "laser",
            generatedAtMs: Date.now(),
            sources: [{ source: "wordnik", status: "skipped", reason: "unconfigured" }],
            candidates: [
              { name: "laser", provenance: ["input", "injected-creative"], registryResults: [] },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    const { byName, fetchImpl: fetchSpy } = await setup(fetchImpl as never);
    const search = byName.get("search_names") as RegisteredToolLike;
    const result = (await search.execute(
      { seed: "laser", injectedCreatives: ["laserly"] },
      {},
    )) as { candidates: { name: string; provenance: string[] }[] };

    const laser = result.candidates.find((c) => c.name === "laser");
    expect(laser?.provenance).toContain("injected-creative");
    // No creative-search (OpenRouter) call was ever attempted.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("creative-search"))).toHaveLength(
      0,
    );
  });

  it("user toggle mid-batch aborts scheduling and the tool reports batch_aborted", async () => {
    let gateRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateRelease = resolve;
    });
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      await gate;
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    const { store, byName } = await setup(fetchImpl as never);
    const batch = byName.get("batch_check_availability") as RegisteredToolLike;

    const pending = batch.execute({ seed: "laser" }, {}) as Promise<unknown>;
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    store.toggleRegistry("pypi", false); // the user wins
    gateRelease();
    const result = (await pending) as { error?: { code: string } };
    expect(result.error?.code).toBe("batch_aborted");
    expect(store.getState().selectedIds).not.toContain("pypi");
  });
});
