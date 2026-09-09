import { describe, expect, it, vi } from "vitest";
import { createGoRegistry, normalizeGoName, type GoRegistryOptions } from "../src/registries/go.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<GoRegistryOptions> = {}): GoRegistryOptions {
  return {
    searchOrigin: "https://pkg.go.test",
    proxyOrigin: "https://proxy.golang.test",
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

describe("normalizeGoName", () => {
  it("accepts bare words and qualified module paths", () => {
    expect(normalizeGoName("  cobra  ")).toEqual({ ok: true, name: "cobra" });
    expect(normalizeGoName("github.com/spf13/cobra")).toEqual({
      ok: true,
      name: "github.com/spf13/cobra",
    });
  });

  it("collapses whitespace and separator runs per path segment (case preserved)", () => {
    expect(normalizeGoName("my cool app")).toEqual({ ok: true, name: "my-cool-app" });
    expect(normalizeGoName("foo--bar")).toEqual({ ok: true, name: "foo-bar" });
    expect(normalizeGoName("foo__bar")).toEqual({ ok: true, name: "foo_bar" });
    expect(normalizeGoName("My Cool App")).toEqual({ ok: true, name: "My-Cool-App" });
    expect(normalizeGoName("example.com/foo bar/baz--qux")).toEqual({
      ok: true,
      name: "example.com/foo-bar/baz-qux",
    });
    // per-character venue: adjacent separators are legal and stay literal
    expect(normalizeGoName("foo_-bar")).toEqual({ ok: true, name: "foo_-bar" });
    // dots stay literal (host segment + version suffixes)
    expect(normalizeGoName("github.com/user/yaml.v2")).toEqual({
      ok: true,
      name: "github.com/user/yaml.v2",
    });
    // upstream allows trailing hyphens on path elements
    expect(normalizeGoName("foo-")).toEqual({ ok: true, name: "foo-" });
  });

  it("rejects invalid go names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["no-dot/path", /not a valid Go module path/],
      ["-leading", /does not allow/],
      ["café", /does not allow/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizeGoName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createGoRegistry bare (fuzzy) lookup", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(new Response("<html>search</html>", { status: 200 }));
    await createGoRegistry(baseOptions({ fetchImpl })).lookup("cobra");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("reports taken+fuzzy when a module candidate's final segment matches", async () => {
    const html = '<a href="/github.com/spf13/cobra">cobra</a><a href="/static/style.css">css</a>';
    const fetchImpl = fakeFetch(new Response(html, { status: 200 }));
    const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup("cobra");
    expect(result).toMatchObject({
      status: "taken",
      fuzzy: true,
      reason: /matched via the pkg.go.dev search page/,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://pkg.go.test/search?q=cobra", expect.anything());
  });

  it("reports available+fuzzy when no module candidate matches", async () => {
    const html = '<a href="/github.com/spf13/viper">viper</a>';
    const fetchImpl = fakeFetch(new Response(html, { status: 200 }));
    const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup("cobra");
    expect(result).toMatchObject({
      status: "available",
      fuzzy: true,
      reason: /not matched on the pkg.go.dev search page/,
    });
  });

  it("honestly reports unknown when pkg.go.dev rate-limits or blocks", async () => {
    const cases: [Response, RegExp][] = [
      [new Response("slow down", { status: 429 }), /rate-limited or blocked/],
      [new Response("forbidden", { status: 403 }), /rate-limited or blocked/],
    ];
    for (const [response, reason] of cases) {
      const fetchImpl = fakeFetch(response);
      const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup("cobra");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(response.status)).toMatch(reason);
    }
  });

  it("reports unknown for other non-200 statuses", async () => {
    const fetchImpl = fakeFetch(new Response("boom", { status: 500 }));
    const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup("cobra");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/status 500/);
  });
});

describe("createGoRegistry qualified (exact) lookup", () => {
  it("reports taken for a 200 proxy payload with a Version string", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ Version: "v1.10.2", Time: "2024-01-01T00:00:00Z" }), {
        status: 200,
      }),
    );
    const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup(
      "github.com/spf13/cobra",
    );
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.golang.test/github.com/spf13/cobra/@latest",
      expect.anything(),
    );
  });

  it("escapes uppercase letters in the module path", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ Version: "v1.0.0" }), { status: 200 }),
    );
    await createGoRegistry(baseOptions({ fetchImpl })).lookup("github.com/Azure/azure-sdk");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.golang.test/github.com/!azure/azure-sdk/@latest",
      expect.anything(),
    );
  });

  it("reports available for 404 or 410 without a fuzzy flag", async () => {
    for (const status of [404, 410]) {
      const fetchImpl = fakeFetch(new Response("Not Found", { status }));
      const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup(
        "github.com/spf13/cobra",
      );
      expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
    }
  });

  it("reports unknown for 200 without a parseable Version", async () => {
    const fetchJson = fakeFetch(
      new Response(JSON.stringify({ Error: "not found" }), { status: 200 }),
    );
    const result = await createGoRegistry(baseOptions({ fetchImpl: fetchJson })).lookup(
      "github.com/spf13/cobra",
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/ambiguous/);
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
      const result = await createGoRegistry(baseOptions({ fetchImpl })).lookup(
        "github.com/spf13/cobra",
      );
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });
});
