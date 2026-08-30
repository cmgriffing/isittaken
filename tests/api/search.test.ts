import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchFunction } from "../../src/functions/search";
import { createTestContext, type TestContextOptions } from "../helpers/test-context";
import type { SearchResponse } from "../../src/domain/types";

let cleanup: () => void;

async function makeHandler(options: TestContextOptions = {}) {
  const context = await createTestContext(options);
  cleanup = context.cleanup;
  return createSearchFunction(context.ctx);
}

beforeEach(() => {
  cleanup = () => {};
});

afterAll(() => {
  cleanup?.();
});

function post(handler: ReturnType<typeof createSearchFunction>, body: unknown, ip = "1.1.1.1") {
  return handler(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nf-client-connection-ip": ip },
      body: JSON.stringify(body),
    }),
  );
}

function wordnikOk() {
  return new Response(
    JSON.stringify([
      { relationshipType: "synonym", words: ["optics"] },
      { relationshipType: "same-context", words: ["photon"] },
    ]),
    { status: 200 },
  );
}

describe("POST /api/search", () => {
  it("returns 200 with seed, wordnik enrichment, and npm results", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(wordnikOk())
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "optics" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const handler = await makeHandler({ fetchImpl });
    const response = await post(handler, { seed: "laser" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as SearchResponse;
    expect(body.seed).toBe("laser");
    expect(body.sources).toEqual([{ source: "wordnik", status: "ok" }]);
    const names = body.candidates.map((c) => c.name);
    expect(names).toContain("laser");
    expect(names).toContain("optics");
    expect(names).toContain("photon");

    const optics = body.candidates.find((c) => c.name === "optics");
    expect(optics?.registryResults[0]).toMatchObject({ registry: "npm", status: "available" });
    const laser = body.candidates.find((c) => c.name === "laser");
    expect(laser?.registryResults[0]).toMatchObject({ registry: "npm", status: "taken" });
    const photon = body.candidates.find((c) => c.name === "photon");
    expect(photon?.registryResults[0]).toMatchObject({ status: "available" });
    expect(typeof photon?.registryResults[0]?.checkedAtMs).toBe("number");
  });

  it("still returns seed and injected npm results when Wordnik fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 })) // wordnik
      .mockResolvedValue(new Response("Not Found", { status: 404 })); // npm

    const handler = await makeHandler({ fetchImpl });
    const response = await post(handler, {
      seed: "laser",
      injectedSynonyms: ["optics"],
      injectedCreatives: ["lazerly"],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as SearchResponse;
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ source: "wordnik", status: "unavailable" });
    const names = body.candidates.map((c) => c.name);
    for (const expected of ["laser", "optics", "lazerly"]) {
      expect(names).toContain(expected);
      const candidate = body.candidates.find((c) => c.name === expected);
      expect(candidate?.registryResults[0]?.status).toBe("available");
    }
  });

  it("never reports availability for ambiguous npm failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 })) // wordnik: empty ok
      .mockResolvedValueOnce(new Response("slow down", { status: 429 })) // npm for laser
      .mockResolvedValueOnce(new Response("boom", { status: 500 })) // npm for optics
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError")); // npm for photon

    const handler = await makeHandler({ fetchImpl });
    const response = await post(handler, { seed: "laser", injectedSynonyms: ["optics", "photon"] });
    expect(response.status).toBe(200);

    const body = (await response.json()) as SearchResponse;
    const statuses = body.candidates.flatMap((c) => c.registryResults.map((r) => r.status));
    expect(statuses).toHaveLength(3);
    for (const status of statuses) {
      expect(status).toBe("unknown");
    }
  });

  it("rejects invalid requests with 400 before any upstream call", async () => {
    const fetchImpl = vi.fn();
    const handler = await makeHandler({ fetchImpl });

    const cases: unknown[] = [
      { seed: "" },
      { seed: "a".repeat(100) },
      { seed: "@scope/pkg" },
      { seed: "ok", injectedSynonyms: ["bad#char"] },
      { seed: "ok", injectedSynonyms: Array.from({ length: 99 }, (_, i) => `w${i}`) },
      {},
      "not-an-object",
    ];
    for (const body of cases) {
      const response = await post(handler, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBeTruthy();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods and oversized/malformed bodies", async () => {
    const handler = await makeHandler();

    const get = await handler(new Request("http://localhost/api/search"));
    expect(get.status).toBe(405);

    const noType = await handler(
      new Request("http://localhost/api/search", { method: "POST", body: "{}" }),
    );
    expect(noType.status).toBe(400);

    const huge = await post(handler, { seed: "a".repeat(20_000) });
    expect((await huge).status).toBe(400);

    const badJson = handler(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    );
    expect((await badJson).status).toBe(400);
  });

  it("throttles per-client-IP with 429 and Retry-After", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const handler = await makeHandler({ fetchImpl, rateLimits: { searchPerMinute: 2 } });

    expect((await post(handler, { seed: "one" }, "9.9.9.9")).status).toBe(200);
    expect((await post(handler, { seed: "two" }, "9.9.9.9")).status).toBe(200);
    const limited = await post(handler, { seed: "three" }, "9.9.9.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // A different client is unaffected.
    expect((await post(handler, { seed: "four" }, "8.8.8.8")).status).toBe(200);
  });
});
