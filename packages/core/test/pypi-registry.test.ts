import { describe, expect, it, vi } from "vitest";
import {
  createPypiRegistry,
  normalizePypiName,
  type PypiRegistryOptions,
} from "../src/registries/pypi.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<PypiRegistryOptions> = {}): PypiRegistryOptions {
  return {
    origin: "https://pypi.test",
    timeoutMs: 1_000,
    clock,
    version: "1.2.3",
    repoUrl: "https://example.test/repo",
    ...overrides,
  };
}

/** Fake fetch that records calls and returns a canned response. */
function fakeFetch(response: Response | Error) {
  const fetchImpl = vi.fn();
  if (response instanceof Error) {
    fetchImpl.mockRejectedValue(response);
  } else {
    fetchImpl.mockResolvedValue(response);
  }
  return fetchImpl;
}

function headersOf(fetchImpl: ReturnType<typeof vi.fn>): Headers {
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return new Headers(init.headers);
}

describe("normalizePypiName", () => {
  it("collapses separator runs and whitespace to a single hyphen (PEP 503)", () => {
    expect(normalizePypiName("Fuzzy_Picker")).toEqual({ ok: true, name: "fuzzy-picker" });
    expect(normalizePypiName("a.b-c_d")).toEqual({ ok: true, name: "a-b-c-d" });
    expect(normalizePypiName("  Laser  ")).toEqual({ ok: true, name: "laser" });
    expect(normalizePypiName("back end")).toEqual({ ok: true, name: "back-end" });
    expect(normalizePypiName("zope.interface")).toEqual({ ok: true, name: "zope-interface" });
  });

  it("rejects invalid pypi names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["-leading", /begin and end with a letter or digit/],
      ["trailing-", /begin and end with a letter or digit/],
      ["foo!bar", /does not allow/],
      ["café", /begin and end with a letter or digit/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizePypiName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createPypiRegistry lookup classification", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(new Response(JSON.stringify({ info: {} }), { status: 200 }));
    await createPypiRegistry(baseOptions({ fetchImpl })).lookup("laser");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("classifies 200 with a parseable project payload as taken", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ info: { name: "laser" } }), { status: 200 }),
    );
    const result = await createPypiRegistry(baseOptions({ fetchImpl })).lookup("laser");
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith("https://pypi.test/pypi/laser/json", expect.anything());
  });

  it("classifies the documented 404 not-found as available", async () => {
    const fetchImpl = fakeFetch(new Response("Not Found", { status: 404 }));
    const result = await createPypiRegistry(baseOptions({ fetchImpl })).lookup("maybe-free");
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("never reports availability for rate limits, timeouts, or errors", async () => {
    const cases: [Response | Error, RegExp, "reject" | "resolve"][] = [
      [new Response("slow down", { status: 429 }), /rate limit/, "resolve"],
      [new Response("boom", { status: 500 }), /status 500/, "resolve"],
      [new DOMException("timed out", "TimeoutError"), /timed out/, "reject"],
      [new Error("ECONNRESET"), /failed/, "reject"],
    ];
    for (const [failure, reason, mode] of cases) {
      const fetchImpl = mode === "reject" ? fakeFetch(failure) : fakeFetch(failure);
      const result = await createPypiRegistry(baseOptions({ fetchImpl })).lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });

  it("treats non-JSON or malformed 200 bodies as ambiguous/unknown", async () => {
    const fetchText = fakeFetch(new Response("<html>ok</html>", { status: 200 }));
    const result = await createPypiRegistry(baseOptions({ fetchImpl: fetchText })).lookup("laser");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/ambiguous/);
  });
});
