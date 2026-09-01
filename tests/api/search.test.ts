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
  it("returns candidates with provenance only — no registry checks", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(wordnikOk());
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

    // Registry work is out of scope for discovery: no upstream registry was
    // contacted and no candidate carries registry results.
    for (const candidate of body.candidates) {
      expect(candidate.registryResults).toEqual([]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1); // wordnik only
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("wordnik");
  });

  it("returns injected candidates with provenance when Wordnik fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, {
      seed: "laser",
      injectedSynonyms: ["optics"],
      injectedCreatives: ["lazerly"],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as SearchResponse;
    expect(body.sources).toEqual([
      { source: "wordnik", status: "unavailable", reason: expect.any(String) },
    ]);
    const byName = new Map(body.candidates.map((c) => [c.name, c]));
    expect(byName.get("laser")?.provenance).toContain("input");
    expect(byName.get("optics")?.provenance).toContain("injected-synonym");
    expect(byName.get("lazerly")?.provenance).toContain("injected-creative");
  });

  it("merges duplicate candidates and unions provenance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, {
      seed: "laser",
      injectedSynonyms: ["Laser", " laser "],
    });
    const body = (await response.json()) as SearchResponse;
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.name).toBe("laser");
    expect(body.candidates[0]?.provenance).toEqual(["input", "injected-synonym"]);
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
    const fetchImpl = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
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
