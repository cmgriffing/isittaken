import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckFunction } from "../../src/functions/check";
import { createTestContext, type TestContextOptions } from "../helpers/test-context";

let cleanup: () => void;

async function makeHandler(options: TestContextOptions = {}) {
  const context = await createTestContext(options);
  cleanup = context.cleanup;
  return createCheckFunction(context.ctx);
}

beforeEach(() => {
  cleanup = () => {};
});

afterAll(() => {
  cleanup?.();
});

function post(handler: ReturnType<typeof createCheckFunction>, body: unknown, ip = "1.1.1.1") {
  return handler(
    new Request("http://localhost/api/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nf-client-connection-ip": ip },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/check", () => {
  it("returns an available verdict from the documented not-found response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "wordsmith", registry: "npm" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      name: string;
      checkedAtMs: number;
    };
    expect(body.status).toBe("available");
    expect(body.name).toBe("wordsmith");
    expect(typeof body.checkedAtMs).toBe("number");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/wordsmith",
      expect.anything(),
    );
  });

  it("normalizes the word per registry before the upstream lookup", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "Back End", registry: "npm" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string; status: string };
    expect(body.name).toBe("back-end");
    expect(body.status).toBe("available");

    const pypi = await post(handler, { word: "Foo_Bar", registry: "pypi" });
    expect(((await pypi.json()) as { name: string }).name).toBe("foo-bar");
  });

  it("classifies a taken name from upstream metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ info: { name: "laser" } }), { status: 200 }),
      );
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "pypi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "taken", name: "laser" });
  });

  it("classifies invalid names without any upstream request", async () => {
    const fetchImpl = vi.fn();
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "@scope/pkg", registry: "npm" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe("invalid");
    expect(body.reason).toMatch(/not supported/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unknown registry ids with a stable error code", async () => {
    const fetchImpl = vi.fn();
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "godependencies" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_registry");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses browser-venue registries with a stable error code", async () => {
    const fetchImpl = vi.fn();
    const handler = await makeHandler({ fetchImpl });

    for (const registry of ["crates", "nuget", "packagist"]) {
      const response = await post(handler, { word: "laser", registry });
      expect(response.status, registry).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("browser_venue_registry");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rate limits per IP and per registry with retry-after, without touching other registries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const context = await createTestContext({
      fetchImpl,
      registrySettings: {
        npm: { rateLimitPerMinute: 2 },
        pypi: { rateLimitPerMinute: 100 },
      },
    });
    cleanup = context.cleanup;
    const handler = createCheckFunction(context.ctx);

    expect((await post(handler, { word: "a", registry: "npm" }, "9.9.9.9")).status).toBe(200);
    expect((await post(handler, { word: "b", registry: "npm" }, "9.9.9.9")).status).toBe(200);
    const limited = await post(handler, { word: "c", registry: "npm" }, "9.9.9.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");

    // Another registry's budget is untouched for the same IP.
    expect((await post(handler, { word: "a", registry: "pypi" }, "9.9.9.9")).status).toBe(200);
    // And another IP's npm budget is untouched.
    expect((await post(handler, { word: "a", registry: "npm" }, "8.8.8.8")).status).toBe(200);
  });

  it("serves a fresh cached verdict with its original check time and no upstream call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const context = await createTestContext({ fetchImpl });
    cleanup = context.cleanup;
    const handler = createCheckFunction(context.ctx);

    const first = await post(handler, { word: "cache-me", registry: "npm" });
    const firstBody = (await first.json()) as { status: string; checkedAtMs: number };
    expect(firstBody.status).toBe("available");

    fetchImpl.mockClear();
    const second = await post(handler, { word: "cache-me", registry: "npm" });
    const secondBody = (await second.json()) as { checkedAtMs: number; status: string };
    expect(secondBody.status).toBe("available");
    expect(secondBody.checkedAtMs).toBe(firstBody.checkedAtMs);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid request shapes and non-POST methods", async () => {
    const handler = await makeHandler();

    const get = await handler(new Request("http://localhost/api/check"));
    expect(get.status).toBe(405);

    const noType = await handler(
      new Request("http://localhost/api/check", { method: "POST", body: "{}" }),
    );
    expect(noType.status).toBe(400);

    const missing = await post(handler, { word: "laser" });
    expect(missing.status).toBe(400);

    const notString = await post(handler, { word: 42, registry: "npm" });
    expect(notString.status).toBe(400);
  });

  it("never reports availability when upstream is ambiguous", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "rubygems" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/rate limit/),
    });
  });
});
