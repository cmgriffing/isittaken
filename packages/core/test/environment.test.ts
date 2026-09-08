import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistryFetch } from "../src/registry-http.js";
import {
  createNpmRegistry,
  createPypiRegistry,
  createRubygemsRegistry,
  createHexRegistry,
  createMavenRegistry,
  createGoRegistry,
  createCratesRegistry,
  createNugetRegistry,
  createPackagistRegistry,
  type PackageRegistry,
} from "../src/index.js";

const SOURCE_ROOT = new URL("../src/", import.meta.url).pathname;

/**
 * A browser-like minimal Response: `.status` plus `.json()` / `.text()` backed
 * by a stored body string. Unlike Node's `Response` builtin (whose body reads
 * depend on `Buffer`), this works with all Node globals deleted, which is what
 * proves the adapters themselves are environment-portable. `AbortSignal` and
 * `Headers` remain available (browser globals).
 */
class FakeResponse {
  readonly status: number;
  readonly ok: boolean;
  private readonly body: string;

  constructor(body: unknown, status = 200) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.body = typeof body === "string" ? body : (JSON.stringify(body) ?? "null");
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }

  async text(): Promise<string> {
    return this.body;
  }
}

/** A fetch factory returning a canned browser-like response per call. */
function browserFetch(body: unknown, status = 200) {
  return vi.fn().mockImplementation(() => Promise.resolve(new FakeResponse(body, status)));
}

const clock = { nowMs: () => 1_000 };

interface VenueCase {
  build: (fetchImpl: typeof fetch) => PackageRegistry;
  name: string;
}

/**
 * Each venue: build its adapter against a fake origin and an injected fetch,
 * look up a name, and capture the (validate, lookup) outcome. The same case
 * runs once with Node globals intact and once with `process`/`Buffer` deleted,
 * and both runs must deep-equal.
 */
const VENUE_CASES: VenueCase[] = [
  {
    name: "npm",
    build: (fetchImpl) =>
      createNpmRegistry({
        origin: "https://npm.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "pypi",
    build: (fetchImpl) =>
      createPypiRegistry({
        origin: "https://pypi.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "rubygems",
    build: (fetchImpl) =>
      createRubygemsRegistry({
        origin: "https://rubygems.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "hex",
    build: (fetchImpl) =>
      createHexRegistry({
        origin: "https://hex.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "maven",
    build: (fetchImpl) =>
      createMavenRegistry({
        searchOrigin: "https://search.maven.test",
        metadataOrigin: "https://repo1.maven.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "go",
    build: (fetchImpl) =>
      createGoRegistry({
        searchOrigin: "https://pkg.go.test",
        proxyOrigin: "https://proxy.golang.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "crates",
    build: (fetchImpl) =>
      createCratesRegistry({
        origin: "https://crates.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "nuget",
    build: (fetchImpl) =>
      createNugetRegistry({
        origin: "https://nuget.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
  {
    name: "packagist",
    build: (fetchImpl) =>
      createPackagistRegistry({
        searchOrigin: "https://packagist.test",
        p2Origin: "https://repo.packagist.test",
        timeoutMs: 1_000,
        clock,
        version: "0.1.0",
        repoUrl: "https://example.test/repo",
        fetchImpl,
      }),
  },
];

/** Return the canned body each venue expects for a 200 "taken" smoke. */
function venueBody(venue: string): unknown {
  switch (venue) {
    case "npm":
      return { "dist-tags": {} };
    case "pypi":
      return { info: {} };
    case "rubygems":
      return { name: "demo" };
    case "hex":
      return { name: "demo" };
    case "maven":
      return { response: { numFound: 1, docs: [{ a: "demo" }] } };
    case "go":
      return '<a href="/github.com/acme/demo">demo</a>';
    case "crates":
      return { crate: { name: "demo" } };
    case "nuget":
      return { versions: ["1.0.0"] };
    case "packagist":
      return { results: [{ name: "acme/demo" }], total: 1 };
    default:
      return {};
  }
}

/** Whether a venue's bare-name check runs a fuzzy search (maven/go/packagist). */
const FUZZY_VENUES = new Set(["maven", "go", "packagist"]);

/** The fuzzy reason a taken venue carries for its search-API match. */
function fuzzyReason(venue: string): string {
  switch (venue) {
    case "maven":
      return "matched via the Maven Central search index (index may lag the registry)";
    case "go":
      return "matched via the pkg.go.dev search page (search may lag the index)";
    case "packagist":
      return "matched via the Packagist search index (search indexes may lag the registry)";
    default:
      return "";
  }
}

function venueCaseBody(venue: string) {
  return {
    validate: { ok: true, name: "demo" },
    lookup: {
      status: "taken" as const,
      checkedAtMs: 1_000,
      ...(FUZZY_VENUES.has(venue) ? { fuzzy: true, reason: fuzzyReason(venue) } : {}),
    },
  };
}

async function runCase(venueCase: VenueCase): Promise<unknown> {
  const body = venueBody(venueCase.name);
  const expected = venueCaseBody(venueCase.name);
  const fetchImpl = browserFetch(body, 200);
  const registry = venueCase.build(fetchImpl as typeof fetch);
  const validate = registry.validate(" demo ");
  const lookup = await registry.lookup("demo");
  expect(validate).toEqual(expected.validate);
  expect(lookup).toEqual(expected.lookup);
  expect(fetchImpl).toHaveBeenCalled();
  return { validate, lookup };
}

describe("core environment portability (D9)", () => {
  describe("static scan: no Node-only APIs in source", () => {
    function* walk(dir: string): Generator<string> {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          yield* walk(full);
        } else if (full.endsWith(".ts")) {
          yield full;
        }
      }
    }

    /** Strip `//` line comments and C-style block comments before scanning. */
    function stripComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    }

    const sourceFiles = [...walk(SOURCE_ROOT)].filter((f) => !f.endsWith(".d.ts"));

    it("source contains no `node:` imports, require, process, or Buffer usage", () => {
      expect(sourceFiles.length).toBeGreaterThan(0);
      for (const file of sourceFiles) {
        const code = stripComments(readFileSync(file, "utf8"));
        expect(
          /from\s+["']node:\/|import\s+["']node:\/|require\(|\bprocess\.|\bBuffer\b/.test(code),
          `${file} uses a Node-only API`,
        ).toBe(false);
      }
    });
  });

  describe("browser-like runtime smoke (no Node globals)", () => {
    it("each venue runs identically with and without process/Buffer", async () => {
      for (const venueCase of VENUE_CASES) {
        const withGlobals = await runCase(venueCase);

        const processDesc = Object.getOwnPropertyDescriptor(globalThis, "process");
        const bufferDesc = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (globalThis as any).process;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (globalThis as any).Buffer;
          const withoutGlobals = await runCase(venueCase);
          expect(withoutGlobals, `${venueCase.name} diverged without Node globals`).toEqual(
            withGlobals,
          );
        } finally {
          if (processDesc) Object.defineProperty(globalThis, "process", processDesc);
          if (bufferDesc) Object.defineProperty(globalThis, "Buffer", bufferDesc);
        }
      }
    });
  });

  describe("UA non-throwing (D7)", () => {
    it("injects user-agent + accept and honors a userAgent override without throwing", async () => {
      const capture: RequestInit[] = [];
      const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capture.push(init ?? {});
        return Promise.resolve(new FakeResponse("ok", 200));
      });

      const doFetch = createRegistryFetch({
        version: "0.1.0",
        repoUrl: "https://github.com/cmgriffing/isittaken",
        timeoutMs: 1_000,
        fetchImpl,
      });

      // Default UA: browsers silently ignore the forbidden user-agent header,
      // but core must still inject it into the captured init without throwing.
      await doFetch("https://npm.test/demo");
      let headers = new Headers(capture[0]?.headers);
      expect(headers.get("user-agent")).toBe(
        "isittaken/0.1.0 (+https://github.com/cmgriffing/isittaken)",
      );
      expect(headers.get("accept")).toBe("application/json");

      // A full userAgent override wins; nothing throws either way.
      await doFetch("https://npm.test/demo", {
        headers: { "user-agent": "custom-bot/1.0" },
      });
      headers = new Headers(capture[1]?.headers);
      expect(headers.get("user-agent")).toBe("custom-bot/1.0");
    });
  });
});
