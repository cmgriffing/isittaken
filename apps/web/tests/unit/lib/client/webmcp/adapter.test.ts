// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebMcpAdapter, type ToolError } from "../../../../../src/lib/client/webmcp/adapter";
import {
  createSearchStore,
  resetSearchStoreForTests,
  type SearchStore,
} from "../../../../../src/lib/client/search-store";

/**
 * Adapter unit tests: feature detection, registration safety, structured
 * validation errors, single-flight refusal, abort semantics, exact-replace
 * selection handling, annotations, and the progress event extension.
 */

const seed = "laser";

function searchResponse() {
  return {
    seed,
    generatedAtMs: Date.now(),
    sources: [{ source: "wordnik", status: "ok" }],
    candidates: [{ name: "laser", provenance: ["input"], registryResults: [] }],
  };
}

function okFetch() {
  return vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/search")) {
      return new Response(JSON.stringify(searchResponse()), { status: 200 });
    }
    if (url.includes("/api/check")) {
      return new Response(
        JSON.stringify({ status: "available", name: "laser", checkedAtMs: Date.now() }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
  });
}

function makeStore(fetchImpl: unknown = okFetch()): SearchStore {
  resetSearchStoreForTests();
  const store = createSearchStore({ fetchImpl: fetchImpl as unknown as typeof fetch });
  vi.stubGlobal("fetch", fetchImpl);
  return store;
}

interface RegisteredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options: { signal?: AbortSignal }) => unknown;
}

function harness(
  options: {
    modelContext?: unknown;
    store?: SearchStore;
    onProgressEvent?: (detail: { tool: string; done: number; total: number }) => void;
  } = {},
) {
  const registered: RegisteredTool[] = [];
  const events: { tool: string; done: number; total: number }[] = [];
  const context = options.modelContext ?? {
    registerTool: (tool: RegisteredTool) => {
      registered.push(tool);
    },
  };
  const adapters = createWebMcpAdapter({
    store: options.store,
    getModelContext: () => context,
    onProgressEvent: options.onProgressEvent ?? ((detail) => events.push(detail)),
  });
  adapters.register();
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return { registered, byName, events };
}

beforeEach(() => {
  resetSearchStoreForTests();
  localStorage.clear();
});

afterEach(() => {
  resetSearchStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("registers all four tools with expected names", () => {
    const { registered } = harness({ store: makeStore() });
    expect(registered.map((tool) => tool.name).sort()).toEqual([
      "batch_check_availability",
      "check_availability",
      "list_registries",
      "search_names",
    ]);
  });

  it("annotates readOnly on all four and untrustedContentHint on the two discovery-bearing tools", () => {
    const { registered } = harness({ store: makeStore() });
    for (const tool of registered) {
      expect(tool.annotations?.["readOnlyHint"], tool.name).toBe(true);
    }
    const byName = new Map(registered.map((tool) => [tool.name, tool]));
    expect(byName.get("search_names")?.annotations?.["untrustedContentHint"]).toBe(true);
    expect(byName.get("batch_check_availability")?.annotations?.["untrustedContentHint"]).toBe(
      true,
    );
    expect(byName.get("check_availability")?.annotations?.["untrustedContentHint"]).toBe(undefined);
    expect(byName.get("list_registries")?.annotations?.["untrustedContentHint"]).toBe(undefined);
  });

  it("warns and continues when registerTool rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registered: RegisteredTool[] = [];
    let rejectRegistration!: (reason: unknown) => void;
    const context = {
      registerTool: (tool: RegisteredTool) => {
        registered.push(tool);
        return new Promise((_resolve, reject) => {
          rejectRegistration = reject;
        });
      },
    };
    const adapters = createWebMcpAdapter({
      store: makeStore(),
      getModelContext: () => context,
    });
    adapters.register();
    expect(registered).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
    rejectRegistration(new Error("not origin-keyed"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it("is a no-op when the draft API is absent (feature detection)", () => {
    const adapter = createWebMcpAdapter({
      store: makeStore(),
      getModelContext: () => undefined,
    });
    // register() resolves without touching anything.
    expect(() => adapter.register()).not.toThrow();
  });
});

describe("list_registries", () => {
  it("returns the full lineup without network calls", () => {
    const fetchImpl = vi.fn();
    const store = makeStore(fetchImpl as unknown as typeof fetch);
    const { byName } = harness({ store });
    const result = (byName.get("list_registries") as RegisteredTool).execute({}, {}) as {
      registries: {
        id: string;
        label: string;
        language: string;
        venue: string;
        linkBase: string;
      }[];
    };
    expect(result.registries.map((r) => r.id)).toEqual([
      "npm",
      "pypi",
      "rubygems",
      "hex",
      "maven",
      "crates",
      "nuget",
      "packagist",
    ]);
    expect(result.registries[0]).toMatchObject({
      label: "npm",
      venue: "server",
      linkBase: "https://registry.npmjs.org",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("search_names", () => {
  it("returns candidates and provenance", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const result = (await (byName.get("search_names") as RegisteredTool).execute({ seed }, {})) as {
      candidates: { name: string; provenance: string[] }[];
      generatedAtMs: number;
    };
    expect(result.candidates.map((c) => c.name)).toContain("laser");
    expect(result.candidates[0]?.provenance).toContain("input");
    expect(result.generatedAtMs).toBeTypeOf("number");
  });

  it("propagates structured validation errors from the domain path", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const scoped = (await (byName.get("search_names") as RegisteredTool).execute(
      { seed: "@scope/pkg" },
      {},
    )) as ToolError;
    expect(scoped.error.code).toBe("unsupported_scope");

    const badInjected = (await (byName.get("search_names") as RegisteredTool).execute(
      { seed: "ok", injectedSynonyms: ["has#char"] },
      {},
    )) as ToolError;
    expect(badInjected.error.code).toBe("invalid_injected");
  });

  it("non-string seed is a structured invalid_seed error without network calls", async () => {
    const fetchImpl = vi.fn();
    const store = makeStore(fetchImpl as unknown as typeof fetch);
    const { byName } = harness({ store });
    const result = (await (byName.get("search_names") as RegisteredTool).execute(
      { seed: 42 },
      {},
    )) as ToolError;
    expect(result.error.code).toBe("invalid_seed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("check_availability", () => {
  it("returns a single verdict through the shared service", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const result = (await (byName.get("check_availability") as RegisteredTool).execute(
      { word: "left-pad", registry: "npm" },
      {},
    )) as { status: string; candidate: string; registry: string; checkedAtMs?: number };
    expect(result.status).toBe("available");
    expect(result.candidate).toBe("left-pad");
    expect(result.registry).toBe("npm");
    expect(result.checkedAtMs).toBeTypeOf("number");
  });

  it("unknown registry is a structured error, not a throw", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const result = (await (byName.get("check_availability") as RegisteredTool).execute(
      { word: "left-pad", registry: "gemfury" },
      {},
    )) as ToolError;
    expect(result.error.code).toBe("unknown_registry");
    expect(result.error.message).toContain("gemfury");
    expect(result.detail).toContain("npm");
  });

  it("missing inputs produce a structured invalid_request error", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const result = (await (byName.get("check_availability") as RegisteredTool).execute(
      {},
      {},
    )) as ToolError;
    expect(result.error.code).toBe("invalid_request");
  });
});

describe("batch_check_availability", () => {
  it("drives the store, resolves the verdict table, and reports selectionUsed", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    const result = (await (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed, registries: ["npm", "pypi"] },
      {},
    )) as {
      candidates: { name: string }[];
      verdicts: { candidate: string; registry: string; status: string }[];
      selectionUsed: string[];
    };
    expect(result.candidates.map((c) => c.name)).toContain("laser");
    expect(result.selectionUsed).toEqual(["npm", "pypi"]);
    expect(result.verdicts.length).toBeGreaterThan(0);
    for (const verdict of result.verdicts) {
      expect(["npm", "pypi"]).toContain(verdict.registry);
    }
    // The batch drove the visible state.
    const state = store.getState();
    expect(state.candidates.length).toBeGreaterThan(0);
  });

  it("exact-replaces the selection and reports unknownRegistries", async () => {
    const store = makeStore();
    const { byName } = harness({ store });
    await (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed, registries: ["npm", "bogus"] },
      {},
    );
    const state = store.getState();
    expect(state.selectedIds).toEqual(["npm"]);
    expect(state.savedIds).not.toEqual(["npm"]); // agent change: ephemeral
  });

  it("empty registries array is a structured error (no batch runs)", async () => {
    const fetchImpl = okFetch();
    const store = makeStore(fetchImpl);
    const { byName } = harness({ store });
    const result = (await (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed, registries: [] },
      {},
    )) as ToolError;
    // The empty-replace guard fires before discovery: only /api/search may
    // have been called, never a check.
    const checkCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/api/check"));
    expect(checkCalls).toHaveLength(0);
    expect(result.error.code).toBe("invalid_request");
  });

  it("refuses concurrent batches with batch_in_progress and progress", async () => {
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
    const store = makeStore(fetchImpl as unknown as typeof fetch);
    const { byName } = harness({ store });

    const first = (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed },
      {},
    ) as Promise<unknown>;
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    const second = (await (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed: "other" },
      {},
    )) as ToolError;
    expect(second.error.code).toBe("batch_in_progress");
    expect(second.detail).toBeTruthy();
    gateRelease();
    await first;
  });

  it("aborting the execute signal clears the gate and restores saved selection", async () => {
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
    const store = makeStore(fetchImpl as unknown as typeof fetch);
    // Saved selection: only npm (user preference).
    store.toggleRegistry("pypi", false);
    store.toggleRegistry("rubygems", false);
    store.toggleRegistry("hex", false);
    store.toggleRegistry("maven", false);
    store.toggleRegistry("crates", false);
    store.toggleRegistry("nuget", false);
    store.toggleRegistry("packagist", false);

    const { byName } = harness({ store });
    const controller = new AbortController();
    const batch = (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed, registries: ["maven"] },
      { signal: controller.signal },
    ) as Promise<unknown>;

    // Replaces selection to ["maven"], saved remains the user's.
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    expect(store.getState().canRestore).toBe(true);
    controller.abort();
    gateRelease();
    const result = (await batch) as ToolError;
    expect(result.error.code).toBe("batch_aborted");
    // The gate is cleared: a new batch can start.
    expect(store.hasBatchInFlight()).toBe(false);
  });

  it("user toggle mid-batch aborts the batch (user wins)", async () => {
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
    const store = makeStore(fetchImpl);
    const { byName } = harness({ store });
    const batch = (byName.get("batch_check_availability") as RegisteredTool).execute(
      { seed },
      {},
    ) as Promise<unknown>;
    await vi.waitFor(() => expect(store.hasBatchInFlight()).toBe(true));
    store.toggleRegistry("hex", false);
    gateRelease();
    const result = (await batch) as ToolError;
    expect(result.error.code).toBe("batch_aborted");
  });
});

describe("progress event extension", () => {
  it("dispatches isittaken:toolprogress on document.modelContext during a batch", async () => {
    const dispatched: CustomEvent[] = [];
    const target = new EventTarget();
    target.addEventListener("isittaken:toolprogress", (event) => {
      dispatched.push(event as CustomEvent);
    });
    // The adapter's default dispatcher re-dispatches on document.modelContext.
    (document as unknown as { modelContext?: unknown }).modelContext = target;
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    const store = makeStore(fetchImpl);
    const registered: RegisteredTool[] = [];
    const context = Object.assign(target, {
      registerTool: (tool: RegisteredTool) => {
        registered.push(tool);
      },
    });
    const adapters = createWebMcpAdapter({
      store,
      getModelContext: () => context,
      onProgressEvent: (detail) => {
        target.dispatchEvent(new CustomEvent("isittaken:toolprogress", { detail }));
      },
    });
    adapters.register();
    const batchTool = registered.find(
      (tool) => tool.name === "batch_check_availability",
    ) as RegisteredTool;
    await batchTool.execute({ seed }, {});
    expect(dispatched.length).toBeGreaterThan(0);
    const detail = dispatched.at(-1)?.detail as {
      tool: string;
      done: number;
      total: number;
    };
    expect(detail.tool).toBe("batch_check_availability");
    expect(detail.done).toBeGreaterThan(0);
    expect(detail.total).toBeGreaterThanOrEqual(detail.done);
    delete (document as unknown as { modelContext?: unknown }).modelContext;
  });
});
