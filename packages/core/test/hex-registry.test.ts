import { describe, expect, it, vi } from "vitest";
import {
  createHexRegistry,
  normalizeHexName,
  type HexRegistryOptions,
} from "../src/registries/hex.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<HexRegistryOptions> = {}): HexRegistryOptions {
  return {
    origin: "https://hex.test",
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

describe("normalizeHexName", () => {
  it("lowercases names and allows underscores", () => {
    expect(normalizeHexName("Phoenix")).toEqual({ ok: true, name: "phoenix" });
    expect(normalizeHexName("  my_pkg  ")).toEqual({ ok: true, name: "my_pkg" });
  });

  it("rejects invalid hex names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["-leading", /start with a letter/],
      ["has-hyphen", /does not allow/],
      ["has space", /does not allow/],
      ["café", /does not allow/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizeHexName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createHexRegistry lookup classification", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(new Response(JSON.stringify({ name: "phoenix" }), { status: 200 }));
    await createHexRegistry(baseOptions({ fetchImpl })).lookup("phoenix");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("classifies 200 with a parseable package payload as taken", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ name: "phoenix", latest_version: "1.7.0" }), { status: 200 }),
    );
    const result = await createHexRegistry(baseOptions({ fetchImpl })).lookup("phoenix");
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hex.test/api/packages/phoenix",
      expect.anything(),
    );
  });

  it("classifies the documented 404 not-found as available", async () => {
    const fetchImpl = fakeFetch(new Response("Not Found", { status: 404 }));
    const result = await createHexRegistry(baseOptions({ fetchImpl })).lookup("maybe-free");
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
      const result = await createHexRegistry(baseOptions({ fetchImpl })).lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });

  it("treats non-JSON 200 bodies as ambiguous/unknown", async () => {
    const fetchText = fakeFetch(new Response("<html>ok</html>", { status: 200 }));
    const result = await createHexRegistry(baseOptions({ fetchImpl: fetchText })).lookup("laser");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/ambiguous/);
  });
});
