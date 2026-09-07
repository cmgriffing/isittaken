import { describe, expect, it, vi } from "vitest";
import {
  createMavenRegistry,
  normalizeMavenName,
  type MavenRegistryOptions,
} from "../src/registries/maven.js";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<MavenRegistryOptions> = {}): MavenRegistryOptions {
  return {
    searchOrigin: "https://search.maven.test",
    metadataOrigin: "https://repo1.maven.test",
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

describe("normalizeMavenName", () => {
  it("keeps case for bare and qualified names", () => {
    expect(normalizeMavenName("  CommonsLang3  ")).toEqual({ ok: true, name: "CommonsLang3" });
    expect(normalizeMavenName("org.apache.commons:commons-lang3")).toEqual({
      ok: true,
      name: "org.apache.commons:commons-lang3",
    });
  });

  it("rejects invalid maven names with reasons", () => {
    const invalid: [string, RegExp][] = [
      ["", /empty/],
      ["   ", /empty/],
      ["has/slash", /not slashes/],
      ["a:b:c", /group:artifact/],
      [":artifact", /group:artifact/],
      ["group:", /group:artifact/],
      ["group..artifact:name", /does not allow/],
      ["has space", /does not allow/],
    ];
    for (const [value, reason] of invalid) {
      const result = normalizeMavenName(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.reason, value).toMatch(reason);
    }
  });
});

describe("createMavenRegistry bare (fuzzy) lookup", () => {
  it("sends the identifying User-Agent and Accept headers", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ response: { docs: [] } }), { status: 200 }),
    );
    await createMavenRegistry(baseOptions({ fetchImpl })).lookup("CommonsLang3");
    const headers = headersOf(fetchImpl);
    expect(headers.get("user-agent")).toBe("isittaken/1.2.3 (+https://example.test/repo)");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("reports taken+fuzzy when a doc's artifactId matches exactly", async () => {
    const fetchImpl = fakeFetch(
      new Response(
        JSON.stringify({
          response: { docs: [{ a: "CommonsLang3", g: "org.apache.commons" }] },
        }),
        { status: 200 },
      ),
    );
    const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup("CommonsLang3");
    expect(result).toMatchObject({
      status: "taken",
      fuzzy: true,
      reason: /matched via the Maven Central search index/,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://search.maven.test/solrsearch/select?q=a:CommonsLang3&rows=20",
      expect.anything(),
    );
  });

  it("reports available+fuzzy when no doc matches", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ response: { docs: [{ a: "Other" }] } }), { status: 200 }),
    );
    const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup("CommonsLang3");
    expect(result).toMatchObject({
      status: "available",
      fuzzy: true,
      reason: /not matched in the Maven Central search index/,
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
      const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup("CommonsLang3");
      expect(result.status).toBe("unknown");
      expect(result.reason, String(response.status)).toMatch(reason);
    }
  });
});

describe("createMavenRegistry qualified (exact) lookup", () => {
  it("reports taken for a 200 metadata XML without a fuzzy flag", async () => {
    const fetchImpl = fakeFetch(
      new Response("<metadata><groupId>org.apache.commons</groupId></metadata>", { status: 200 }),
    );
    const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup(
      "org.apache.commons:commons-lang3",
    );
    expect(result).toEqual({ status: "taken", checkedAtMs: 1_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://repo1.maven.test/org/apache/commons/commons-lang3/maven-metadata.xml",
      expect.anything(),
    );
  });

  it("reports available for a 404 without a fuzzy flag", async () => {
    const fetchImpl = fakeFetch(new Response("Not Found", { status: 404 }));
    const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup(
      "org.apache.commons:commons-lang3",
    );
    expect(result).toEqual({ status: "available", checkedAtMs: 1_000 });
  });

  it("reports unknown for 200 without <metadata>", async () => {
    const fetchImpl = fakeFetch(new Response("<html>not metadata</html>", { status: 200 }));
    const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup(
      "org.apache.commons:commons-lang3",
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
      const result = await createMavenRegistry(baseOptions({ fetchImpl })).lookup(
        "org.apache.commons:commons-lang3",
      );
      expect(result.status).toBe("unknown");
      expect(result.reason, String(failure)).toMatch(reason);
    }
  });
});
