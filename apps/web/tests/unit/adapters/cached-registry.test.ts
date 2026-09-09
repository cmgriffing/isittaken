import { describe, expect, it, vi } from "vitest";
import {
  createCachedRegistry,
  registryCacheKey,
  type CachedRegistryOptions,
  type RegistryCachePolicies,
} from "../../../src/adapters/registries/cached-registry";
import {
  createHexRegistry,
  createMavenRegistry,
  createNpmRegistry,
  createPypiRegistry,
  createRubygemsRegistry,
  type PackageRegistry,
} from "@isittaken/core";

const clock = { nowMs: () => 1_000 };

const policies: RegistryCachePolicies = {
  available: { freshForMs: 300_000, retainForMs: 3_600_000 },
  taken: { freshForMs: 86_400_000, retainForMs: 604_800_000 },
};

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

function cached(
  registry: PackageRegistry,
  cache: unknown,
  cachePolicies: RegistryCachePolicies = policies,
): PackageRegistry {
  return createCachedRegistry({
    registry,
    cache: cache as never,
    cachePolicies,
  } satisfies CachedRegistryOptions);
}

describe("createCachedRegistry", () => {
  it("serves fresh cache hits and preserves the original check time", async () => {
    const cachedValue = JSON.stringify({
      version: 1,
      data: { status: "available", checkedAtMs: 555 },
    });
    const cache = {
      read: vi.fn().mockResolvedValue({ status: "fresh", valueJson: cachedValue }),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const registry = cached(baseRegistry(fetchImpl), cache);
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
    const registry = cached(baseRegistry(fetchImpl), cache);
    const result = await registry.lookup("laser");
    expect(result.status).toBe("available");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("mirrors verdicts into both generic families with per-verdict policy", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchTaken = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "laser" }), { status: 200 }));
    await cached(baseRegistry(fetchTaken), cache).lookup("laser");
    expect(write).toHaveBeenCalledTimes(2);
    const families = write.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(families).toEqual(["registry-available", "registry-taken"]);
    for (const call of write.mock.calls) {
      const [, key, , usedPolicy] = call as unknown as [string, string, string, unknown];
      expect(key).toBe(registryCacheKey("npm", "laser"));
      expect(usedPolicy).toEqual(policies.taken);
    }

    const fetchAvailable = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    await cached(baseRegistry(fetchAvailable), cache).lookup("free-one");
    for (const call of write.mock.calls.slice(2)) {
      const [, , , usedPolicy] = call as unknown as [string, string, string, unknown];
      expect(usedPolicy).toEqual(policies.available);
    }
  });

  it("does not cache unknown outcomes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    await cached(baseRegistry(fetchImpl), cache).lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });

  it("degrades to an upstream lookup when the cache read throws", async () => {
    const cache = {
      read: vi.fn().mockRejectedValue(new Error("cache down")),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = cached(baseRegistry(fetchImpl), cache);
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
    const registry = cached(baseRegistry(fetchImpl), cache);
    const result = await registry.lookup("laser");
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("passes through id and validate from the wrapped registry", () => {
    const registry = cached(baseRegistry(vi.fn()), { read: vi.fn(), write: vi.fn() });
    expect(registry.id).toBe("npm");
    expect(registry.validate("Back-End")).toEqual({ ok: true, name: "back-end" });
    expect(registry.validate("@scope/pkg")).toMatchObject({ ok: false });
  });
});

/**
 * Ported coverage from main's server-registries.test.ts (the generic
 * server-venue adapter). The decorator wraps the transport-pure core
 * adapters, so the classification assertions exercise the wrapped adapter
 * while the cache assertions exercise the decorator.
 */

function pypi(fetchImpl: typeof fetch): PackageRegistry {
  return createPypiRegistry({
    origin: "https://pypi.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    fetchImpl,
  });
}

function rubygems(fetchImpl: typeof fetch): PackageRegistry {
  return createRubygemsRegistry({
    origin: "https://rubygems.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    fetchImpl,
  });
}

function hex(fetchImpl: typeof fetch): PackageRegistry {
  return createHexRegistry({
    origin: "https://hex.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    fetchImpl,
  });
}

function maven(fetchImpl: typeof fetch): PackageRegistry {
  return createMavenRegistry({
    searchOrigin: "https://search.maven.test",
    metadataOrigin: "https://repo1.maven.test",
    timeoutMs: 1_000,
    clock,
    version: "0.1.0",
    repoUrl: "https://github.com/cmgriffing/isittaken",
    fetchImpl,
  });
}

describe("cached server-venue adapters: taken path", () => {
  it.each([
    ["pypi", pypi, () => new Response(JSON.stringify({ info: { name: "x" } }), { status: 200 })],
    ["rubygems", rubygems, () => new Response(JSON.stringify({ name: "x" }), { status: 200 })],
    ["hex", hex, () => new Response(JSON.stringify({ name: "x", meta: {} }), { status: 200 })],
    [
      "maven",
      maven,
      () =>
        new Response(JSON.stringify({ response: { numFound: 1, docs: [{ id: "g:x", a: "x" }] } }), {
          status: 200,
        }),
    ],
  ])("%s: classifies the documented metadata response as taken", async (_id, build, responder) => {
    const fetchImpl = vi.fn().mockResolvedValue(responder());
    const registry = cached(build(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });
    const result = await registry.lookup("x");
    expect(result.status).toBe("taken");
    expect(result.checkedAtMs).toBe(1_000);
  });
});

describe("cached server-venue adapters: available path", () => {
  it.each([
    ["pypi", pypi, () => new Response("Not Found", { status: 404 })],
    ["rubygems", rubygems, () => new Response("This ruby could not be found.", { status: 404 })],
    ["hex", hex, () => new Response(JSON.stringify({ status: "not_found" }), { status: 404 })],
    [
      "maven",
      maven,
      () => new Response(JSON.stringify({ response: { numFound: 0, docs: [] } }), { status: 200 }),
    ],
  ])(
    "%s: classifies the documented not-found response as available",
    async (_id, build, responder) => {
      const fetchImpl = vi.fn().mockResolvedValue(responder());
      const registry = cached(build(fetchImpl), {
        read: vi.fn().mockResolvedValue({ status: "miss" }),
        write: vi.fn(),
      });
      const result = await registry.lookup("free-name");
      expect(result.status).toBe("available");
    },
  );
});

describe("cached server-venue adapter behaviors", () => {
  it("pypi: normalizes per PEP 503 before lookup and classifies invalid locally", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = cached(pypi(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });

    const validation = registry.validate("Foo_Bar.Baz");
    expect(validation).toEqual({ ok: true, name: "foo-bar-baz" });

    // Core adapters expect a pre-normalized name; the check handler validates
    // first and passes `validation.name` to lookup.
    await registry.lookup("foo-bar");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pypi.test/pypi/foo-bar/json",
      expect.anything(),
    );

    // PEP 503: leading/trailing separators are invalid, never looked up.
    const invalid = registry.validate("-nope");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/begin and end/);
    const dotted = registry.validate("ok-name");
    expect(dotted.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rubygems: preserves case and uses the gems JSON API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "back-end" }), { status: 200 }));
    const registry = cached(rubygems(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });
    // RubyGems normalization is trim-only (case preserved); whitespace is invalid.
    expect(registry.validate("Back-End")).toEqual({ ok: true, name: "Back-End" });
    expect(registry.validate("Back End").ok).toBe(false);
    await registry.lookup("back-end");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://rubygems.test/api/v1/gems/back-end.json",
      expect.anything(),
    );
  });

  it("hex: lowercases names and rejects Hex-unsupported characters locally", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "x" }), { status: 200 }));
    const registry = cached(hex(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });

    await registry.lookup("some_pkg");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hex.test/api/packages/some_pkg",
      expect.anything(),
    );

    const invalid = registry.validate("has.dot");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/Hex does not allow/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maven: filters search results to exact artifactId matches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          response: {
            numFound: 2,
            docs: [
              { id: "g:laser-ext", a: "laser-ext" },
              { id: "g:laser", a: "laser" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const registry = cached(maven(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });
    const result = await registry.lookup("laser");
    expect(result.status).toBe("taken");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://search.maven.test/solrsearch/select?q=a:laser&rows=20",
      expect.anything(),
    );
  });

  it("maven: an exact match beyond the first page is inconclusive (unknown)", async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: `g:v${i}`, a: `v${i}` }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ response: { numFound: 42, docs } }), { status: 200 }),
      );
    const registry = cached(maven(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });
    const result = await registry.lookup("hidden-artifact");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/inconclusive/);
  });

  it("maven: an unexpected body is unknown, never available", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 200 }));
    const registry = cached(maven(fetchImpl), {
      read: vi.fn().mockResolvedValue({ status: "miss" }),
      write: vi.fn(),
    });
    const result = await registry.lookup("laser");
    expect(result.status).toBe("unknown");
  });

  it("classifies 429 as unknown with a reason for every server-venue registry", async () => {
    for (const build of [pypi, rubygems, hex, maven]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
      const registry = cached(build(fetchImpl), {
        read: vi.fn().mockResolvedValue({ status: "miss" }),
        write: vi.fn(),
      });
      const result = await registry.lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason).toMatch(/rate limit/);
    }
  });

  it("classifies timeouts and transport failures as unknown", async () => {
    for (const build of [pypi, rubygems, hex, maven]) {
      const fetchImpl = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      const registry = cached(build(fetchImpl), {
        read: vi.fn().mockResolvedValue({ status: "miss" }),
        write: vi.fn(),
      });
      const result = await registry.lookup("laser");
      expect(result.status).toBe("unknown");
      expect(result.reason).toMatch(/timed out/);
    }
  });

  it("serves fresh cache hits without an upstream request", async () => {
    const cachedValue = JSON.stringify({
      version: 1,
      data: { status: "taken", checkedAtMs: 555 },
    });
    const cache = {
      read: vi.fn().mockResolvedValue({ status: "fresh", valueJson: cachedValue }),
      write: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const registry = cached(pypi(fetchImpl), cache);
    const result = await registry.lookup("laser");
    expect(result).toEqual({ status: "taken", checkedAtMs: 555 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.read).toHaveBeenCalledWith(
      "registry-available",
      registryCacheKey("pypi", "laser"),
    );
  });

  it("falls back upstream on cache miss and mirrors the verdict into both families", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ info: { name: "laser" } }), { status: 200 }),
      );
    const registry = cached(pypi(fetchImpl), cache);
    const result = await registry.lookup("laser");
    expect(result.status).toBe("taken");

    expect(write).toHaveBeenCalledTimes(2);
    const families = write.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(families).toEqual(["registry-available", "registry-taken"]);
    const [, key, valueJson, usedPolicy] = write.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
    ];
    expect(key).toBe(registryCacheKey("pypi", "laser"));
    expect(JSON.parse(valueJson)).toEqual({
      version: 1,
      data: { status: "taken", checkedAtMs: 1_000 },
    });
    expect(usedPolicy).toEqual(policies.taken);
  });

  it("overwrites a verdict flip after the cached entry expires", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = {
      read: vi.fn().mockImplementation(async (_family: string, key: string) =>
        key === registryCacheKey("pypi", "laser")
          ? { status: "stale" } // expired-but-retained entry: must not be served
          : { status: "miss" },
      ),
      write,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ info: { name: "laser" } }), { status: 200 }),
      );
    const registry = cached(pypi(fetchImpl), cache);
    const result = await registry.lookup("laser");
    expect(result.status).toBe("taken");
    expect(write).toHaveBeenCalledWith(
      "registry-taken",
      registryCacheKey("pypi", "laser"),
      expect.any(String),
      policies.taken,
    );
  });

  it("does not cache unknown outcomes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const registry = cached(pypi(fetchImpl), cache);
    await registry.lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });
});
