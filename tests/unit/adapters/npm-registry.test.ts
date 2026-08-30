import { describe, expect, it, vi } from "vitest";
import {
  createNpmRegistry,
  normalizeNpmName,
  type NpmRegistryOptions,
} from "../../../src/adapters/npm/registry";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<NpmRegistryOptions> = {}): NpmRegistryOptions {
  return {
    origin: "https://registry.npm.test",
    timeoutMs: 1_000,
    clock,
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

  it("serves fresh cache hits and preserves the original check time", async () => {
    const cachedValue = JSON.stringify({
      version: 1,
      data: { status: "available", checkedAtMs: 555 },
    });
    const cache = {
      read: vi
        .fn()
        .mockImplementation(async (family: string) =>
          family === "npm-available"
            ? { status: "fresh", valueJson: cachedValue }
            : { status: "miss" },
        ),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const registry = createNpmRegistry(baseOptions({ fetchImpl, cache: cache as never }));
    const result = await registry.lookup("laser");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "available", checkedAtMs: 555 });
  });

  it("writes results to the family matching the outcome", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const policies = {
      "npm-available": { freshForMs: 300_000, retainForMs: 3_600_000 },
      "npm-taken": { freshForMs: 86_400_000, retainForMs: 604_800_000 },
    };
    const fetchTaken = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "laser" }), { status: 200 }));
    await createNpmRegistry(
      baseOptions({ fetchImpl: fetchTaken, cache: cache as never, cachePolicies: policies }),
    ).lookup("laser");
    expect(write).toHaveBeenCalledTimes(1);
    const [family, , , usedPolicy] = write.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
    ];
    expect(family).toBe("npm-taken");
    expect(usedPolicy).toEqual(policies["npm-taken"]);

    const fetchAvailable = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    await createNpmRegistry(
      baseOptions({ fetchImpl: fetchAvailable, cache: cache as never, cachePolicies: policies }),
    ).lookup("free-one");
    const [family2] = write.mock.calls[1] as unknown as [string];
    expect(family2).toBe("npm-available");
  });

  it("does not cache unknown outcomes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    await createNpmRegistry(baseOptions({ fetchImpl, cache: cache as never })).lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });
});
