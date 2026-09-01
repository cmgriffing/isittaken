import { describe, expect, it, vi } from "vitest";
import {
  createNpmRegistry,
  normalizeNpmName,
  type NpmRegistryOptions,
} from "../../../src/adapters/npm/registry";
import { registryCacheKey } from "../../../src/adapters/registries/server-adapter";

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

  it("serves fresh cache hits from a single read and preserves the original check time", async () => {
    const cachedValue = JSON.stringify({
      version: 1,
      data: { status: "available", checkedAtMs: 555 },
    });
    const cache = {
      read: vi.fn().mockResolvedValue({ status: "fresh", valueJson: cachedValue }),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const registry = createNpmRegistry(baseOptions({ fetchImpl, cache: cache as never }));
    const result = await registry.lookup("laser");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "available", checkedAtMs: 555 });
    // Decision D5: a single family read; the verdict comes from the value.
    expect(cache.read).toHaveBeenCalledTimes(1);
    expect(cache.read).toHaveBeenCalledWith("registry-available", registryCacheKey("npm", "laser"));
  });

  it("ignores cache values with an unexpected verdict payload", async () => {
    const cache = {
      read: vi.fn().mockResolvedValue({
        status: "fresh",
        valueJson: JSON.stringify({ version: 1, data: { status: "nonsense", checkedAtMs: 5 } }),
      }),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createNpmRegistry(baseOptions({ fetchImpl, cache: cache as never }));
    const result = await registry.lookup("laser");
    expect(result.status).toBe("available");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("mirrors verdicts into both generic families with per-verdict policy", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const policies = {
      available: { freshForMs: 300_000, retainForMs: 3_600_000 },
      taken: { freshForMs: 86_400_000, retainForMs: 604_800_000 },
    };
    const fetchTaken = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "laser" }), { status: 200 }));
    await createNpmRegistry(
      baseOptions({ fetchImpl: fetchTaken, cache: cache as never, cachePolicies: policies }),
    ).lookup("laser");
    expect(write).toHaveBeenCalledTimes(2);
    const families = write.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(families).toEqual(["registry-available", "registry-taken"]);
    for (const call of write.mock.calls) {
      const [, key, , usedPolicy] = call as unknown as [string, string, string, unknown];
      expect(key).toBe(registryCacheKey("npm", "laser"));
      expect(usedPolicy).toEqual(policies.taken);
    }

    const fetchAvailable = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    await createNpmRegistry(
      baseOptions({ fetchImpl: fetchAvailable, cache: cache as never, cachePolicies: policies }),
    ).lookup("free-one");
    for (const call of write.mock.calls.slice(2)) {
      const [, , , usedPolicy] = call as unknown as [string, string, string, unknown];
      expect(usedPolicy).toEqual(policies.available);
    }
  });

  it("does not cache unknown outcomes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    await createNpmRegistry(baseOptions({ fetchImpl, cache: cache as never })).lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });
});
