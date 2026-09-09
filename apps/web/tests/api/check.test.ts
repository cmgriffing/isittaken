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

  it("flags a bare-word maven search match as fuzzy with an explanatory reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: { numFound: 1, docs: [{ id: "g:laser", a: "laser" }] },
        }),
        { status: 200 },
      ),
    );
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "maven" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      fuzzy?: boolean;
      reason?: string;
    };
    expect(body.status).toBe("taken");
    expect(body.fuzzy).toBe(true);
    expect(body.reason).toMatch(/search index/);
  });

  it("serves go as a server venue, flagging bare-word search matches as fuzzy", async () => {
    // A bare word hits the pkg.go.dev search page; a matching module path
    // classifies as a fuzzy taken lead.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<a href="/github.com/example/laser">github.com/example/laser</a>', {
        status: 200,
      }),
    );
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "go" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      fuzzy?: boolean;
      reason?: string;
    };
    expect(body.status).toBe("taken");
    expect(body.fuzzy).toBe(true);
    expect(body.reason).toMatch(/search page/);
    expect(fetchImpl).toHaveBeenCalledWith("https://pkg.go.dev/search?q=laser", expect.anything());
  });

  it("returns honest unknown for go when pkg.go.dev blocks the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("blocked", { status: 403 }));
    const handler = await makeHandler({ fetchImpl });

    const response = await post(handler, { word: "laser", registry: "go" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe("unknown");
    expect(body.reason).toMatch(/blocked/);
  });

  it("rate limits go per IP with its descriptor budget", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const context = await createTestContext({
      fetchImpl,
      registrySettings: { go: { rateLimitPerMinute: 1 } },
    });
    cleanup = context.cleanup;
    const handler = createCheckFunction(context.ctx);

    expect((await post(handler, { word: "a", registry: "go" }, "5.5.5.5")).status).toBe(200);
    const limited = await post(handler, { word: "b", registry: "go" }, "5.5.5.5");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects request bodies over the 2KB cap", async () => {
    const handler = await makeHandler();
    const oversized = await handler(
      new Request("http://localhost/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word: "a".repeat(2_100), registry: "npm" }),
      }),
    );
    expect(oversized.status).toBe(400);
    const body = (await oversized.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("echoes a correlation id on every response", async () => {
    const handler = await makeHandler();
    const response = await post(handler, { word: "laser", registry: "npm" });
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("logs a structured check_failed event and returns a generic 500 without leaking upstream detail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Core adapters classify transport failures as `unknown` rather than
      // throwing, so to exercise the 500 path we inject a registry whose
      // lookup genuinely throws (e.g. an unexpected adapter bug).
      const throwingRegistry = {
        id: "npm",
        validate: () => ({ ok: true, name: "laser" }),
        lookup: async () => {
          throw new Error("upstream secret detail");
        },
      };
      const context = await createTestContext({});
      cleanup = context.cleanup;
      const handler = createCheckFunction({
        ...context.ctx,
        serverRegistries: new Map([["npm", throwingRegistry as never]]),
      });

      const response = await post(handler, { word: "laser", registry: "npm" });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("internal");
      expect(body.error.message).not.toMatch(/upstream secret detail/);

      const logged = errorSpy.mock.calls
        .map((call) => call[0])
        .find((line) => typeof line === "string" && line.includes("check_failed"));
      expect(logged).toBeTruthy();
      expect(String(logged)).toContain("correlationId");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a structured check_rate_limited event when a venue is rate limited", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
      const context = await createTestContext({
        fetchImpl,
        registrySettings: { npm: { rateLimitPerMinute: 1 } },
      });
      cleanup = context.cleanup;
      const handler = createCheckFunction(context.ctx);

      await post(handler, { word: "a", registry: "npm" }, "7.7.7.7");
      const limited = await post(handler, { word: "b", registry: "npm" }, "7.7.7.7");
      expect(limited.status).toBe(429);

      const logged = warnSpy.mock.calls
        .map((call) => call[0])
        .find((line) => typeof line === "string" && line.includes("check_rate_limited"));
      expect(logged).toBeTruthy();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs a structured check_registry_unavailable event when the adapter is missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const context = await createTestContext({});
      cleanup = context.cleanup;
      const handler = createCheckFunction({
        ...context.ctx,
        serverRegistries: new Map(),
      });

      const response = await post(handler, { word: "laser", registry: "npm" });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("internal");

      const logged = errorSpy.mock.calls
        .map((call) => call[0])
        .find((line) => typeof line === "string" && line.includes("check_registry_unavailable"));
      expect(logged).toBeTruthy();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
