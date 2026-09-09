import { describe, expect, it, vi } from "vitest";
import {
  createNpmRegistry,
  normalizeNpmName,
  type NpmRegistryOptions,
} from "../src/registries/npm.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<NpmRegistryOptions> = {}): NpmRegistryOptions {
  return {
    origin: "https://registry.npm.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    ...overrides,
  };
}

describe("normalizeNpmName", () => {
  it("accepts and normalizes plausible unscoped names", () => {
    expect(normalizeNpmName("laser")).toEqual({ ok: true, name: "laser" });
    expect(normalizeNpmName("Back-End")).toEqual({ ok: true, name: "back-end" });
    expect(normalizeNpmName("back end")).toEqual({ ok: true, name: "back-end" });
    expect(normalizeNpmName("pkg.js_v2")).toEqual({ ok: true, name: "pkg.js_v2" });
  });

  it("rejects invalid npm names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["@scope/pkg", /not supported/],
      ["has/slash", /not supported/],
      [`${"a".repeat(215)}`, /214-character/],
      ["-leading", /start with a letter/],
      [".dotfile", /start with a letter/],
      ["_under", /start with a letter/],
      ["has space!", /characters npm does not allow/],
      ["trailing-", /end with a hyphen/],
      ["café", /characters npm does not allow/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizeNpmName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createNpmRegistry lookup classification", () => {
  it("classifies 200 metadata as taken", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ "dist-tags": {} }), { status: 200 }));
    const registry = createNpmRegistry(baseOptions({ fetchImpl }));
    const result = await registry.lookup("laser");
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith("https://registry.npm.test/laser", expect.anything());
  });

  it("classifies the documented 404 not-found as available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createNpmRegistry(baseOptions({ fetchImpl }));
    const result = await registry.lookup("maybe-free");
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
      const fetchImpl =
        mode === "reject" ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(failure);
      const registry = createNpmRegistry(baseOptions({ fetchImpl }));
      const result = await registry.lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });

  it("treats non-JSON or malformed 200 bodies as ambiguous/unknown", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(["array", "not", "metadata"]), { status: 200 }),
      );
    const result = await createNpmRegistry(baseOptions({ fetchImpl: fetchJson })).lookup("laser");
    expect(result.status).toBe("unknown");

    const fetchText = vi.fn().mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));
    const result2 = await createNpmRegistry(baseOptions({ fetchImpl: fetchText })).lookup("laser");
    expect(result2.status).toBe("unknown");
  });
});
