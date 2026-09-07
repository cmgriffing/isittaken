import { describe, expect, it, vi } from "vitest";
import { createRegistryFetch, type RegistryFetchOptions } from "../src/registry-http.js";

function baseOptions(overrides: Partial<RegistryFetchOptions> = {}): RegistryFetchOptions {
  return {
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe("createRegistryFetch", () => {
  it("sets the default User-Agent in the exact isittaken/<version> (+<repo-url>) format", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl }));
    await doFetch("https://registry.npm.test/laser");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toBe(
      "isittaken/0.1.0 (+https://github.com/cmgriffing/isittaken)",
    );
  });

  it("sets the Accept header to application/json", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl }));
    await doFetch("https://registry.npm.test/laser");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("applies the timeout via AbortSignal.timeout when no signal is supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl, timeoutMs: 5_000 }));
    await doFetch("https://registry.npm.test/laser");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("lets the caller's headers override the defaults (including user-agent)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl }));
    await doFetch("https://registry.npm.test/laser", {
      headers: { "user-agent": "custom-agent", accept: "text/plain" },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toBe("custom-agent");
    expect(headers.get("accept")).toBe("text/plain");
  });

  it("lets the caller's signal win over the default timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl }));
    const callerSignal = AbortSignal.timeout(123);
    await doFetch("https://registry.npm.test/laser", { signal: callerSignal });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(callerSignal);
  });

  it("preserves other init fields (method, body) and supports fetchImpl injection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(baseOptions({ fetchImpl }));
    await doFetch("https://registry.npm.test/laser", {
      method: "POST",
      body: "hello",
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("hello");
  });

  it("honors the per-venue userAgent override option", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const doFetch = createRegistryFetch(
      baseOptions({ fetchImpl, userAgent: "my-venue-bot/1.0 (+https://example.com)" }),
    );
    await doFetch("https://registry.npm.test/laser");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toBe("my-venue-bot/1.0 (+https://example.com)");
  });
});
