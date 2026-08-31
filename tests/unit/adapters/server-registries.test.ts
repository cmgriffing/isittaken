import { describe, expect, it, vi } from "vitest";
import {
  createServerRegistryAdapter,
  registryCacheKey,
  type RegistryCachePolicies,
  type ServerRegistryAdapterOptions,
} from "../../../src/adapters/registries/server-adapter";
import {
  HEX_DESCRIPTOR,
  MAVEN_DESCRIPTOR,
  PYPI_DESCRIPTOR,
  RUBYGEMS_DESCRIPTOR,
} from "../../../src/domain/registries";
import type { RegistryDescriptor } from "../../../src/domain/registries";

const clock = { nowMs: () => 1_000 };

const policies: RegistryCachePolicies = {
  available: { freshForMs: 300_000, retainForMs: 3_600_000 },
  taken: { freshForMs: 86_400_000, retainForMs: 604_800_000 },
};

function options(
  descriptor: RegistryDescriptor,
  overrides: Partial<ServerRegistryAdapterOptions> = {},
): ServerRegistryAdapterOptions {
  return { descriptor, timeoutMs: 1_000, clock, ...overrides };
}

/** (registry, upstream response) pairs for each server-venue adapter. */
const takenResponses: [RegistryDescriptor, () => Response][] = [
  [PYPI_DESCRIPTOR, () => new Response(JSON.stringify({ info: { name: "x" } }), { status: 200 })],
  [RUBYGEMS_DESCRIPTOR, () => new Response(JSON.stringify({ name: "x" }), { status: 200 })],
  [HEX_DESCRIPTOR, () => new Response(JSON.stringify({ name: "x", meta: {} }), { status: 200 })],
  [
    MAVEN_DESCRIPTOR,
    () =>
      new Response(JSON.stringify({ response: { numFound: 1, docs: [{ id: "g:x", a: "x" }] } }), {
        status: 200,
      }),
  ],
];

const availableResponses: [RegistryDescriptor, () => Response][] = [
  [PYPI_DESCRIPTOR, () => new Response("Not Found", { status: 404 })],
  [RUBYGEMS_DESCRIPTOR, () => new Response("This ruby could not be found.", { status: 404 })],
  [HEX_DESCRIPTOR, () => new Response(JSON.stringify({ status: "not_found" }), { status: 404 })],
  [
    MAVEN_DESCRIPTOR,
    () => new Response(JSON.stringify({ response: { numFound: 0, docs: [] } }), { status: 200 }),
  ],
];

describe.each(takenResponses.map(([d]) => [d.id, d] as const))(
  "%s adapter: taken path",
  (_id, descriptor) => {
    it("classifies the documented metadata response as taken", async () => {
      const responder = takenResponses.find(([d]) => d.id === descriptor.id)![1];
      const fetchImpl = vi.fn().mockResolvedValue(responder());
      const registry = createServerRegistryAdapter(options(descriptor, { fetchImpl }));
      const result = await registry.lookup("x");
      expect(result.status).toBe("taken");
      expect(result.checkedAtMs).toBe(1_000);
    });
  },
);

describe.each(availableResponses.map(([d]) => [d.id, d] as const))(
  "%s adapter: available path",
  (_id, descriptor) => {
    it("classifies the documented not-found response as available", async () => {
      const responder = availableResponses.find(([d]) => d.id === descriptor.id)![1];
      const fetchImpl = vi.fn().mockResolvedValue(responder());
      const registry = createServerRegistryAdapter(options(descriptor, { fetchImpl }));
      const result = await registry.lookup("free-name");
      expect(result.status).toBe("available");
    });
  },
);

describe("per-registry adapter behaviors", () => {
  it("pypi: normalizes per PEP 503 before lookup and classifies invalid locally", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createServerRegistryAdapter(options(PYPI_DESCRIPTOR, { fetchImpl }));

    const validation = registry.validate("Foo_Bar.Baz");
    expect(validation).toEqual({ ok: true, name: "foo-bar-baz" });

    await registry.lookup("Foo_Bar");
    expect(fetchImpl).toHaveBeenCalledWith("https://pypi.org/pypi/foo-bar/json", expect.anything());

    // PEP 503: leading/trailing separators are invalid, never looked up.
    const invalid = registry.validate("-nope");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/begin and end/);
    const dotted = registry.validate("ok-name");
    expect(dotted.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rubygems: uses the default normalizer and the gems JSON API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "back-end" }), { status: 200 }));
    const registry = createServerRegistryAdapter(options(RUBYGEMS_DESCRIPTOR, { fetchImpl }));
    expect(registry.validate("Back End")).toEqual({ ok: true, name: "back-end" });
    await registry.lookup("back end");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://rubygems.org/api/v1/gems/back-end.json",
      expect.anything(),
    );
  });

  it("hex: lowercases names and rejects Hex-unsupported characters locally", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ name: "x" }), { status: 200 }));
    const registry = createServerRegistryAdapter(options(HEX_DESCRIPTOR, { fetchImpl }));

    await registry.lookup("Some_Pkg");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hex.pm/api/packages/some_pkg",
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
    const registry = createServerRegistryAdapter(options(MAVEN_DESCRIPTOR, { fetchImpl }));
    const result = await registry.lookup("laser");
    expect(result.status).toBe("taken");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://search.maven.org/solrsearch/select?q=a%3Alaser",
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
    const registry = createServerRegistryAdapter(options(MAVEN_DESCRIPTOR, { fetchImpl }));
    const result = await registry.lookup("hidden-artifact");
    expect(result.status).toBe("unknown");
    expect(result.reason).toMatch(/inconclusive/);
  });

  it("maven: an unexpected body is unknown, never available", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 200 }));
    const registry = createServerRegistryAdapter(options(MAVEN_DESCRIPTOR, { fetchImpl }));
    const result = await registry.lookup("laser");
    expect(result.status).toBe("unknown");
  });

  it("classifies 429 as unknown with a reason for every server-venue registry", async () => {
    for (const descriptor of [
      PYPI_DESCRIPTOR,
      RUBYGEMS_DESCRIPTOR,
      HEX_DESCRIPTOR,
      MAVEN_DESCRIPTOR,
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
      const registry = createServerRegistryAdapter(options(descriptor, { fetchImpl }));
      const result = await registry.lookup("laser");
      expect(result.status, descriptor.id).toBe("unknown");
      expect(result.reason, descriptor.id).toMatch(/rate limit/);
    }
  });

  it("classifies timeouts and transport failures as unknown", async () => {
    for (const descriptor of [
      PYPI_DESCRIPTOR,
      RUBYGEMS_DESCRIPTOR,
      HEX_DESCRIPTOR,
      MAVEN_DESCRIPTOR,
    ]) {
      const fetchImpl = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      const registry = createServerRegistryAdapter(options(descriptor, { fetchImpl }));
      const result = await registry.lookup("laser");
      expect(result.status, descriptor.id).toBe("unknown");
      expect(result.reason, descriptor.id).toMatch(/timed out/);
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
    const registry = createServerRegistryAdapter(
      options(PYPI_DESCRIPTOR, { fetchImpl, cache: cache as never, cachePolicies: policies }),
    );
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
    const registry = createServerRegistryAdapter(
      options(PYPI_DESCRIPTOR, { fetchImpl, cache: cache as never, cachePolicies: policies }),
    );
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
    const registry = createServerRegistryAdapter(
      options(PYPI_DESCRIPTOR, { fetchImpl, cache: cache as never, cachePolicies: policies }),
    );
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
    const registry = createServerRegistryAdapter(
      options(PYPI_DESCRIPTOR, { fetchImpl, cache: cache as never, cachePolicies: policies }),
    );
    await registry.lookup("laser");
    expect(write).not.toHaveBeenCalled();
  });

  it("sends the descriptor User-Agent when declared", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const registry = createServerRegistryAdapter(options(RUBYGEMS_DESCRIPTOR, { fetchImpl }));
    await registry.lookup("laser");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["user-agent"]).toBeUndefined();
  });
});
