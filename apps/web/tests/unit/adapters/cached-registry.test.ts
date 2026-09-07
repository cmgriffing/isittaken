import { describe, expect, it, vi } from "vitest";
import { createCachedNpmRegistry } from "../../../src/adapters/npm/cached-registry";
import { createNpmRegistry, type PackageRegistry } from "@isittaken/core";

const clock = { nowMs: () => 1_000 };

function baseRegistry(fetchImpl: typeof fetch): PackageRegistry {
  return createNpmRegistry({
    origin: "https://registry.npm.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    fetchImpl,
  });
}

function policies() {
  return {
    "npm-available": { freshForMs: 300_000, retainForMs: 3_600_000 },
    "npm-taken": { freshForMs: 86_400_000, retainForMs: 604_800_000 },
  };
}

describe("createCachedNpmRegistry", () => {
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
    const registry = createCachedNpmRegistry({
      registry: baseRegistry(fetchImpl),
      cache: cache as never,
      cachePolicies: policies(),
    });
    const result = await registry.lookup("laser");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "available", checkedAtMs: 555 });
  });

  it("writes results to the family matching the outcome", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const cachePolicies = policies();
    const fetchTaken = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "laser" }), { status: 200 }));
    await createCachedNpmRegistry({
      registry: baseRegistry(fetchTaken),
      cache: cache as never,
      cachePolicies,
    }).lookup("laser");
    expect(write).toHaveBeenCalledTimes(1);
    const [family, , , usedPolicy] = write.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
    ];
    expect(family).toBe("npm-taken");
    expect(usedPolicy).toEqual(cachePolicies["npm-taken"]);

    const fetchAvailable = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    await createCachedNpmRegistry({
      registry: baseRegistry(fetchAvailable),
      cache: cache as never,
      cachePolicies,
    }).lookup("free-one");
    const [family2] = write.mock.calls[1] as unknown as [string];
    expect(family2).toBe("npm-available");
  });

  it("does not cache unknown outcomes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    await createCachedNpmRegistry({
      registry: baseRegistry(fetchImpl),
      cache: cache as never,
      cachePolicies: policies(),
    }).lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes a versioned envelope that a later read can decode", async () => {
    const written: { family: string; key: string; valueJson: string }[] = [];
    const cache = {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn().mockImplementation(async (family: string, key: string, valueJson: string) => {
        written.push({ family, key, valueJson });
      }),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    await createCachedNpmRegistry({
      registry: baseRegistry(fetchImpl),
      cache: cache as never,
      cachePolicies: policies(),
    }).lookup("free-one");

    expect(written).toHaveLength(1);
    const envelope = JSON.parse(written[0]?.valueJson as string) as {
      version: number;
      data: { status: string; checkedAtMs: number };
    };
    expect(envelope.version).toBe(1);
    expect(envelope.data).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("degrades to an upstream lookup when the cache read throws", async () => {
    const cache = {
      read: vi.fn().mockRejectedValue(new Error("cache down")),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createCachedNpmRegistry({
      registry: baseRegistry(fetchImpl),
      cache: cache as never,
      cachePolicies: policies(),
    });
    const result = await registry.lookup("laser");
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("degrades to an upstream lookup when the cache write throws", async () => {
    const cache = {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn().mockRejectedValue(new Error("write down")),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createCachedNpmRegistry({
      registry: baseRegistry(fetchImpl),
      cache: cache as never,
      cachePolicies: policies(),
    });
    const result = await registry.lookup("laser");
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("passes through id and validate from the wrapped registry", () => {
    const registry = createCachedNpmRegistry({
      registry: baseRegistry(vi.fn()),
      cache: { read: vi.fn(), write: vi.fn() } as never,
      cachePolicies: policies(),
    });
    expect(registry.id).toBe("npm");
    expect(registry.validate("Back-End")).toEqual({ ok: true, name: "back-end" });
    expect(registry.validate("@scope/pkg")).toMatchObject({ ok: false });
  });
});
