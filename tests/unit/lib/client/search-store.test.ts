// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSearchStore,
  cellKey,
  resetSearchStoreForTests,
  REGISTRY_SELECTION_STORAGE_KEY,
  type SearchStore,
} from "../../../../src/lib/client/search-store";
import type { SearchResponse } from "../../../../src/domain/types";

/**
 * Store-level behavior: subscription notifications, selection
 * replace/revert (agent vs user paths), abort propagation, and progress
 * accounting during the fan-out.
 */

const seed = "laser";

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    seed,
    generatedAtMs: Date.now(),
    sources: [{ source: "wordnik", status: "ok" }],
    candidates: [
      { name: "laser", provenance: ["input"], registryResults: [] },
      { name: "optics", provenance: ["wordnik-synonym"], registryResults: [] },
    ],
    ...overrides,
  };
}

function okFetch(options: { checkDelayMs?: number } = {}) {
  return vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/search")) {
      return new Response(JSON.stringify(searchResponse()), { status: 200 });
    }
    if (url.includes("/api/check")) {
      if (options.checkDelayMs) await new Promise((r) => setTimeout(r, options.checkDelayMs));
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
  });
}

function createStore(overrides: { fetchImpl?: typeof fetch } = {}): SearchStore {
  resetSearchStoreForTests();
  localStorage.clear();
  const fetchImpl = overrides.fetchImpl ?? okFetch();
  const store = createSearchStore({ fetchImpl });
  // Discovery (api.ts) speaks to the global fetch; stub it for both paths.
  vi.stubGlobal("fetch", fetchImpl);
  return store;
}

afterEach(() => {
  resetSearchStoreForTests();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
});

describe("search store subscription", () => {
  it("notifies subscribers on state changes and supports unsubscribe", async () => {
    const store = createStore();
    const events: number[] = [];
    const unsubscribe = store.subscribe(() => events.push(events.length));

    await store.runSearch(seed);
    expect(events.length).toBeGreaterThan(0);

    unsubscribe();
    const count = events.length;
    await store.runSearch(`${seed}2`);
    expect(events.length).toBe(count);
  });

  it("getState returns the current snapshot with candidates after a search", async () => {
    const store = createStore();
    await store.runSearch(seed);
    const state = store.getState();
    expect(state.phase).toBe("done");
    expect(state.candidates.map((c) => c.name)).toContain("laser");
    expect(state.ordinary?.seed).toBe(seed);
  });
});

describe("selection replace and revert", () => {
  it("user toggle persists to localStorage and updates savedIds", () => {
    const store = createStore();
    store.toggleRegistry("pypi", false);
    const state = store.getState();
    expect(state.selectedIds).not.toContain("pypi");
    expect(state.savedIds).not.toContain("pypi");
    expect(state.canRestore).toBe(false);
    const persisted = JSON.parse(
      localStorage.getItem(REGISTRY_SELECTION_STORAGE_KEY) ?? "[]",
    ) as string[];
    expect(persisted).not.toContain("pypi");
  });

  it("agent selection replaces the live selection, never localStorage", () => {
    const store = createStore();
    store.toggleRegistry("npm", false); // saved: everything but npm
    const before = localStorage.getItem(REGISTRY_SELECTION_STORAGE_KEY);

    const result = store.setAgentSelection(["hex", "maven"]);
    expect(result.unknownRegistries).toEqual([]);
    const state = store.getState();
    expect(state.selectedIds).toEqual(["hex", "maven"]);
    expect(state.agentTouched).toBe(true);
    expect(state.canRestore).toBe(true);
    // npm was user-deselected (absent from both saved and live, so not in
    // the diff); the five saved ids the agent removed do differ.
    expect(state.agentChangedIds).toContain("pypi");
    expect(state.agentChangedIds).not.toContain("hex");
    expect(state.agentChangedIds).not.toContain("npm");
    // localStorage untouched by the agent path.
    expect(localStorage.getItem(REGISTRY_SELECTION_STORAGE_KEY)).toBe(before);
  });

  it("agent selection reports unknown registry ids and ignores them", () => {
    const store = createStore();
    const result = store.setAgentSelection(["maven", "gemfury"]);
    expect(result.unknownRegistries).toEqual(["gemfury"]);
    expect(store.getState().selectedIds).toEqual(["maven"]);
  });

  it("empty agent selection clears the live selection", () => {
    const store = createStore();
    store.setAgentSelection([]);
    expect(store.getState().selectedIds).toEqual([]);
  });

  it("restoreSavedSelection returns to the saved selection", async () => {
    const store = createStore();
    await store.runSearch(seed);
    store.setAgentSelection(["maven"]);
    expect(store.getState().canRestore).toBe(true);
    store.restoreSavedSelection();
    const state = store.getState();
    expect(state.canRestore).toBe(false);
    expect(state.agentTouched).toBe(false);
    expect(state.savedIds).toEqual(state.selectedIds);
  });
});

describe("progress accounting and abort propagation", () => {
  it("reports progress during the fan-out and clears it when settled", async () => {
    const fetchImpl = okFetch();
    resetSearchStoreForTests();
    const store = createSearchStore({ fetchImpl });
    vi.stubGlobal("fetch", fetchImpl);
    const sample = () => store.getProgress();
    let sawProgress = false;
    const unsubscribe = store.subscribe(() => {
      if (sample() !== null) sawProgress = true;
    });
    await store.runSearch(seed);
    unsubscribe();
    expect(sawProgress).toBe(true);
    expect(store.getProgress()).toBeNull();
  });

  it("abort stops scheduling new checks; batch resolves fulfilled", async () => {
    let inFlight = 0;
    let gateRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateRelease = resolve;
    });
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      inFlight += 1;
      await gate;
      inFlight -= 1;
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    resetSearchStoreForTests();
    const store = createSearchStore({ fetchImpl });
    vi.stubGlobal("fetch", fetchImpl);

    const batch = store.runBatch({ seed });
    // Abort while the fan-out waits on the gate.
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    store.abortBatch();
    gateRelease();
    const result = await batch;

    // The batch fulfills (never rejects) with a structured aborted result;
    // queued-but-unscheduled checks never fetched.
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(inFlight).toBe(0);
  });

  it("user toggle mid-batch aborts the batch scheduling", async () => {
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
    resetSearchStoreForTests();
    const store = createSearchStore({ fetchImpl });
    vi.stubGlobal("fetch", fetchImpl);

    const batch = store.runBatch({ seed });
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    // User wins: toggle interrupts scheduling.
    store.toggleRegistry("hex", false);
    gateRelease();
    await batch;
    const state = store.getState();
    expect(state.batchInFlight).toBe(false);
    expect(state.selectedIds).not.toContain("hex");
  });
});

describe("cellKey", () => {
  it("joins candidate name and registry id", () => {
    expect(cellKey("laser", "npm")).toBe("laser|npm");
  });
});
