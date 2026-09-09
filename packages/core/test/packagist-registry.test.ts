import { describe, expect, it, vi } from "vitest";
import {
  createPackagistRegistry,
  normalizePackagistName,
  type PackagistRegistryOptions,
} from "../src/registries/packagist.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<PackagistRegistryOptions> = {}): PackagistRegistryOptions {
  return {
    searchOrigin: "https://packagist.test",
    p2Origin: "https://repo.packagist.test",
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

describe("normalizePackagistName", () => {
  it("lowercases bare and qualified names", () => {
    expect(normalizePackagistName("  Fuzzy-Picker  ")).toEqual({ ok: true, name: "fuzzy-picker" });
    expect(normalizePackagistName("Symfony/Console")).toEqual({
      ok: true,
      name: "symfony/console",
    });
  });

  it("rejects invalid packagist names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["has space", /cannot contain spaces/],
      ["a/b/c", /vendor\/name/],
      ["/name", /vendor\/name/],
      ["vendor/", /vendor\/name/],
      ["-leading", /does not allow/],
      ["trailing-", /end with a hyphen/],
      ["vendor/-name", /does not allow/],
      ["vendor/name-", /end with a hyphen/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizePackagistName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createPackagistRegistry bare (fuzzy) lookup", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 }),
    );
    await createPackagistRegistry(baseOptions({ fetchImpl })).lookup("fuzzy-picker");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("reports taken+fuzzy when a result's final segment matches", async () => {
    const fetchImpl = fakeFetch(
      new Response(
        JSON.stringify({
          results: [{ name: "acme/fuzzy-picker", description: "a picker" }],
          total: 1,
        }),
        { status: 200 },
      ),
    );
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup("fuzzy-picker");
    expect(result).toMatchObject({
      status: "taken",
      fuzzy: true,
      reason: /matched via the Packagist search index/,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://packagist.test/search.json?q=fuzzy-picker",
      expect.anything(),
    );
  });

  it("reports available+fuzzy when no result matches and the set is complete", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ results: [{ name: "acme/other" }], total: 1 }), {
        status: 200,
      }),
    );
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup("fuzzy-picker");
    expect(result).toMatchObject({
      status: "available",
      fuzzy: true,
      reason: /not matched in the Packagist search index/,
    });
  });

  it("reports unknown+fuzzy when the search is paginated (total exceeds results)", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ results: [{ name: "acme/other" }], total: 50 }), {
        status: 200,
      }),
    );
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup("fuzzy-picker");
    expect(result).toMatchObject({
      status: "unknown",
      fuzzy: true,
      reason: "inconclusive search results.",
    });
  });

  it("reports unknown+fuzzy when the body lacks a trustworthy total", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ results: [{ name: "acme/other" }] }), { status: 200 }),
    );
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup("fuzzy-picker");
    expect(result).toMatchObject({
      status: "unknown",
      fuzzy: true,
      reason: "inconclusive search results.",
    });
  });

  it("reports unknown for non-200 or malformed search responses", async () => {
    const cases: [Response, RegExp][] = [
      [new Response("Not Found", { status: 404 }), /status 404/],
      [new Response("slow down", { status: 429 }), /rate limit/],
      [new Response("boom", { status: 500 }), /status 500/],
      [new Response("<html>ok</html>", { status: 200 }), /ambiguous/],
    ];
    for (const [response, reason] of cases) {
      const fetchImpl = fakeFetch(response);
      const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup(
        "fuzzy-picker",
      );
      expect(result.status).toBe("unknown");
      expect(result.reason, String(response.status)).toMatch(reason);
    }
  });
});

describe("createPackagistRegistry qualified (exact) lookup", () => {
  it("reports taken for a 200 p2 metadata payload without a fuzzy flag", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ packages: { "symfony/console": {} } }), { status: 200 }),
    );
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup(
      "symfony/console",
    );
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://repo.packagist.test/p2/symfony/console.json",
      expect.anything(),
    );
  });

  it("reports available for a 404 without a fuzzy flag", async () => {
    const fetchImpl = fakeFetch(new Response("Not Found", { status: 404 }));
    const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup(
      "symfony/console",
    );
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("reports unknown for rate limits, timeouts, and errors", async () => {
    const cases: [Response | Error, RegExp, "reject" | "resolve"][] = [
      [new Response("slow down", { status: 429 }), /rate limit/, "resolve"],
      [new Response("boom", { status: 500 }), /status 500/, "resolve"],
      [new DOMException("timed out", "TimeoutError"), /timed out/, "reject"],
      [new Error("ECONNRESET"), /failed/, "reject"],
    ];
    for (const [failure, reason, mode] of cases) {
      const fetchImpl = mode === "reject" ? fakeFetch(failure) : fakeFetch(failure);
      const result = await createPackagistRegistry(baseOptions({ fetchImpl })).lookup(
        "symfony/console",
      );
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });
});
