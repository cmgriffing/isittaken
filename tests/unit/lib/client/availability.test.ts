// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createAvailabilityService,
  type VerdictCell,
} from "../../../../src/lib/client/availability";
import { VerdictCache } from "../../../../src/lib/client/verdict-cache";
import {
  NPM_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  CRATES_DESCRIPTOR,
} from "../../../../src/domain/registries";
import type { RegistryDescriptor } from "../../../../src/domain/registries";

const NOW = 1_700_000_000_000;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | "reject",
) {
  const fetchImpl = vi
    .fn()
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const result = await handler(String(input), init);
      if (result === "reject") throw new Error("network failure");
      return result;
    });
  return fetchImpl;
}

function collect() {
  const cells: VerdictCell[] = [];
  return { cells, onResult: (cell: VerdictCell) => cells.push(cell) };
}

function ttlFor(descriptor: RegistryDescriptor) {
  return (registryId: string, status: string) =>
    registryId === descriptor.id
      ? status === "available"
        ? descriptor.cacheTtl.availableMs
        : descriptor.cacheTtl.takenMs
      : 0;
}

describe("createAvailabilityService", () => {
  it("routes server-venue registries through /api/check", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes("/api/check")
        ? new Response(JSON.stringify({ status: "available", checkedAtMs: NOW }), { status: 200 })
        : new Response("unexpected", { status: 500 }),
    );
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore(), ttlFor: ttlFor(NPM_DESCRIPTOR) }),
    });

    await service.checkCandidates([{ name: "laser" }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/check");
    expect(cells).toEqual([
      expect.objectContaining({
        registry: "npm",
        candidateName: "laser",
        checkedName: "laser",
        status: "available",
        cached: false,
      }),
    ]);
  });

  it("routes browser-venue registries through direct fetches with shared classification", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe("https://crates.io/api/v1/crates/laser");
      return new Response(JSON.stringify({ crate: { name: "laser" } }), { status: 200 });
    });
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [CRATES_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore(), ttlFor: ttlFor(CRATES_DESCRIPTOR) }),
    });

    await service.checkCandidates([{ name: "laser" }]);
    expect(cells[0]).toMatchObject({ registry: "crates", status: "taken" });
  });

  it("dedupes candidates that normalize to the same registry name", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes("/api/check")
        ? new Response(JSON.stringify({ status: "taken", checkedAtMs: NOW }), { status: 200 })
        : new Response("Not Found", { status: 404 }),
    );
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [PYPI_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore(), ttlFor: ttlFor(PYPI_DESCRIPTOR) }),
    });

    // "back end" and "back-end" normalize to the same PEP 503 name.
    await service.checkCandidates([{ name: "back end" }, { name: "back-end" }]);
    // One network call, two cells sharing the verdict.
    const checkCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/api/check"));
    expect(checkCalls).toHaveLength(1);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.checkedName).toBe("back-end");
      expect(cell.status).toBe("taken");
    }
  });

  it("classifies invalid names locally without network calls", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("should not be called");
    });
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore() }),
    });

    await service.checkCandidates([{ name: "@scope/pkg" }]);
    expect(cells[0]).toMatchObject({ status: "invalid", reason: expect.any(String) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds concurrent checks with the configured cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = fakeFetch(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ status: "available", checkedAtMs: NOW }), {
        status: 200,
      });
    });
    const { onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR],
      onResult,
      concurrency: 3,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore() }),
    });

    await service.checkCandidates(Array.from({ length: 12 }, (_, i) => ({ name: `word-${i}` })));
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("reschedules 429 checks after retry-after and gives up after bounded retries", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fakeFetch(
        () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
      );
      const { cells, onResult } = collect();
      const service = createAvailabilityService({
        registries: [NPM_DESCRIPTOR],
        onResult,
        maxRetries: 2,
        now: () => NOW,
        fetchImpl,
        cache: new VerdictCache({ store: memoryStore() }),
      });

      const done = service.checkCandidates([{ name: "laser" }]);
      await vi.advanceTimersByTimeAsync(3_000); // first retry
      await vi.advanceTimersByTimeAsync(3_000); // second retry -> exhausted
      await done;

      expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
      expect(cells[0]).toMatchObject({
        status: "unknown",
        reason: expect.stringMatching(/retries exhausted/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders other registries' verdicts when one registry's check fails", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { registry?: string };
      if (body.registry === "npm") return "reject";
      return new Response(JSON.stringify({ status: "taken", checkedAtMs: NOW }), { status: 200 });
    });
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR, PYPI_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache: new VerdictCache({ store: memoryStore() }),
    });

    await service.checkCandidates([{ name: "laser" }]);
    const byRegistry = new Map(cells.map((c) => [c.registry, c]));
    expect(byRegistry.get("npm")?.status).toBe("unknown");
    expect(byRegistry.get("pypi")?.status).toBe("taken");
  });

  it("uses fresh cache verdicts without network calls and no cached hint", async () => {
    const store = memoryStore();
    const cache = new VerdictCache({ store, ttlFor: ttlFor(NPM_DESCRIPTOR) });
    cache.write("npm", "laser", "available", NOW - 1_000, NOW - 1_000);

    const fetchImpl = fakeFetch(() => {
      throw new Error("should not be called");
    });
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache,
    });

    await service.checkCandidates([{ name: "laser" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cells[0]).toMatchObject({ status: "available", cached: false });
  });

  it("paints stale verdicts with a cached hint, then revalidates", async () => {
    const store = memoryStore();
    const cache = new VerdictCache({ store, ttlFor: ttlFor(NPM_DESCRIPTOR) });
    // Written long ago: availableMs (5min) elapsed, but retention (7x) not.
    cache.write("npm", "laser", "available", NOW - 10 * 60_000, NOW - 10 * 60_000);

    const fetchImpl = fakeFetch((url) => {
      expect(String(url)).toBe("/api/check");
      return new Response(JSON.stringify({ status: "taken", checkedAtMs: NOW }), { status: 200 });
    });
    const { cells, onResult } = collect();
    const service = createAvailabilityService({
      registries: [NPM_DESCRIPTOR],
      onResult,
      now: () => NOW,
      fetchImpl,
      cache,
    });

    await service.checkCandidates([{ name: "laser" }]);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ status: "available", cached: true });
    expect(cells[1]).toMatchObject({ status: "taken", cached: false });
  });
});

describe("VerdictCache", () => {
  const ttl = 60_000;

  function makeCache(maxEntries = 500) {
    const store = memoryStore();
    return {
      store,
      cache: new VerdictCache({
        store,
        maxEntries,
        ttlFor: (_registryId, status) => (status === "taken" ? ttl * 10 : ttl),
      }),
    };
  }

  it("serves fresh within TTL and stale after", () => {
    const { cache } = makeCache();
    cache.write("npm", "laser", "available", NOW, NOW);
    expect(cache.read("npm", "laser", NOW + 1)?.status).toBe("fresh");
    expect(cache.read("npm", "laser", NOW + ttl + 1)?.status).toBe("stale");
    // Retention = 7x TTL; beyond that the entry is gone.
    expect(cache.read("npm", "laser", NOW + ttl * 8)).toBeNull();
  });

  it("evicts least-recently-used entries beyond the cap", () => {
    const { cache } = makeCache(3);
    cache.write("npm", "a", "taken", NOW, NOW);
    cache.write("npm", "b", "taken", NOW, NOW);
    cache.write("npm", "c", "taken", NOW, NOW);
    // Touch "a" so "b" becomes the LRU entry.
    cache.read("npm", "a", NOW + 1);
    cache.write("npm", "d", "taken", NOW, NOW + 2);
    expect(cache.read("npm", "b", NOW + 3)).toBeNull();
    expect(cache.read("npm", "a", NOW + 3)).not.toBeNull();
    expect(cache.read("npm", "d", NOW + 3)).not.toBeNull();
  });

  it("persists across instances via the storage backend", () => {
    const { store, cache } = makeCache();
    cache.write("npm", "laser", "taken", NOW, NOW);
    const revived = new VerdictCache({ store, ttlFor: () => ttl });
    expect(revived.read("npm", "laser", NOW + 1)?.verdict.status).toBe("taken");
  });
});
