import { describe, expect, it, vi } from "vitest";
import {
  createNugetRegistry,
  normalizeNugetName,
  type NugetRegistryOptions,
} from "../src/registries/nuget.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<NugetRegistryOptions> = {}): NugetRegistryOptions {
  return {
    origin: "https://nuget.test",
    timeoutMs: 1_000,
    clock,
    version: "1.2.3",
    repoUrl: "https://example.test/repo",
    ...overrides,
  };
}

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

describe("normalizeNugetName", () => {
  it("lowercases case-insensitive names", () => {
    expect(normalizeNugetName("Mixed.Case")).toEqual({ ok: true, name: "mixed.case" });
    expect(normalizeNugetName("  Newtonsoft.Json  ")).toEqual({
      ok: true,
      name: "newtonsoft.json",
    });
  });

  it("collapses whitespace and underscore runs; keeps dots literal and no cross-map", () => {
    expect(normalizeNugetName("has space")).toEqual({ ok: true, name: "has-space" });
    expect(normalizeNugetName("my cool app")).toEqual({ ok: true, name: "my-cool-app" });
    // underscore runs are legal upstream (word chars) and collapse to one
    expect(normalizeNugetName("foo__bar")).toEqual({ ok: true, name: "foo_bar" });
    expect(normalizeNugetName("foo___bar")).toEqual({ ok: true, name: "foo_bar" });
    // dots stay literal; no cross-canonicalization of `-`/`_`
    expect(normalizeNugetName("my.cool.lib")).toEqual({ ok: true, name: "my.cool.lib" });
    expect(normalizeNugetName("foo_bar")).toEqual({ ok: true, name: "foo_bar" });
    // underscore is a word char upstream: adjacent to separators and trailing are legal
    expect(normalizeNugetName("foo_-bar")).toEqual({ ok: true, name: "foo_-bar" });
    expect(normalizeNugetName("trailing_")).toEqual({ ok: true, name: "trailing_" });
    expect(normalizeNugetName("foo_.bar")).toEqual({ ok: true, name: "foo_.bar" });
  });

  it("rejects invalid nuget names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["-leading", /start with a letter/],
      ["has/slash", /does not allow/],
      ["café", /does not allow/],
      // upstream `^\w+([.-]\w+)*$`: single `.`/`-` separators (underscore is a word char)
      ["foo--bar", /consecutive separators/],
      ["foo---bar", /consecutive separators/],
      ["foo.-bar", /consecutive separators/],
      ["foo..bar", /consecutive separators/],
      ["trailing.", /end with a separator/],
      ["trailing-", /end with a separator/],
      ["foo -", /consecutive separators/],
      ["foo-", /end with a separator/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizeNugetName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createNugetRegistry lookup classification", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ versions: ["1.0.0"] }), { status: 200 }),
    );
    await createNugetRegistry(baseOptions({ fetchImpl })).lookup("mixed.case");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("classifies 200 with a versions array as taken", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ versions: ["1.0.0", "2.0.0"] }), { status: 200 }),
    );
    const result = await createNugetRegistry(baseOptions({ fetchImpl })).lookup("mixed.case");
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://nuget.test/v3-flatcontainer/mixed.case/index.json",
      expect.anything(),
    );
  });

  it("classifies the documented 404 not-found as available", async () => {
    const fetchImpl = fakeFetch(new Response("Not Found", { status: 404 }));
    const result = await createNugetRegistry(baseOptions({ fetchImpl })).lookup("maybe-free");
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
      const result = await createNugetRegistry(baseOptions({ fetchImpl })).lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });

  it("treats 200 JSON without a versions array as ambiguous/unknown", async () => {
    const fetchJson = fakeFetch(new Response(JSON.stringify({ name: "laser" }), { status: 200 }));
    const result = await createNugetRegistry(baseOptions({ fetchImpl: fetchJson })).lookup("laser");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/ambiguous/);
  });

  it("treats non-JSON 200 bodies as ambiguous/unknown", async () => {
    const fetchText = fakeFetch(new Response("<html>ok</html>", { status: 200 }));
    const result = await createNugetRegistry(baseOptions({ fetchImpl: fetchText })).lookup("laser");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/ambiguous/);
  });
});
