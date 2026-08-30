import { describe, expect, it, vi } from "vitest";
import {
  createWordnikSource,
  type WordnikSourceOptions,
} from "../../../src/adapters/wordnik/source";

const clock = { nowMs: () => 1_000 };

function baseOptions(overrides: Partial<WordnikSourceOptions> = {}): WordnikSourceOptions {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.wordnik.test/v4",
    timeoutMs: 1_000,
    clock,
    ...overrides,
  };
}

function wordnikResponse() {
  return [
    { relationshipType: "synonym", words: ["laser", "maser"] },
    { relationshipType: "same-context", words: ["beam", "photon"] },
    { relationshipType: "weird-type", words: ["ignored-shape"] },
  ];
}

describe("createWordnikSource", () => {
  it("maps relationship types to provenance and skips unknown types", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(wordnikResponse()), { status: 200 }));
    const source = createWordnikSource(baseOptions({ fetchImpl }));

    const result = await source.fetch("laser");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.candidates).toEqual([
      { value: "laser", provenance: "wordnik-synonym" },
      { value: "maser", provenance: "wordnik-synonym" },
      { value: "beam", provenance: "wordnik-related" },
      { value: "photon", provenance: "wordnik-related" },
    ]);
  });

  it("reports rate limits and HTTP errors as unavailable, with the upstream error body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const result = await createWordnikSource(baseOptions({ fetchImpl })).fetch("laser");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/rate limit/);
      expect(result.reason).toContain("slow down");
    }

    const fetch500 = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const result500 = await createWordnikSource(baseOptions({ fetchImpl: fetch500 })).fetch(
      "laser",
    );
    expect(result500.status).toBe("unavailable");
    if (result500.status === "unavailable") {
      expect(result500.reason).toMatch(/status 500/);
      expect(result500.reason).toContain("boom");
    }
  });

  it("includes the upstream 400 error details and redacts credentials", async () => {
    // Wordnik 400s carry the explanation (e.g. invalid key or parameters).
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('{"message":"invalid api_key=SECRET123 supplied"}', { status: 400 }),
      );
    const result = await createWordnikSource(baseOptions({ fetchImpl })).fetch("laser");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toMatch(/status 400/);
      expect(result.reason).toContain("invalid");
      expect(result.reason).not.toContain("SECRET123");
      expect(result.reason).toContain("[redacted]");
    }
  });

  it("maps timeouts and transport failures to unavailable", async () => {
    const timeoutFetch = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const result = await createWordnikSource(baseOptions({ fetchImpl: timeoutFetch })).fetch(
      "laser",
    );
    expect(result).toEqual({ status: "unavailable", reason: "Wordnik request timed out." });

    const brokenFetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result2 = await createWordnikSource(baseOptions({ fetchImpl: brokenFetch })).fetch(
      "laser",
    );
    expect(result2.status).toBe("unavailable");
  });

  it("treats unexpected payloads as unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ oops: true }), { status: 200 }));
    const result = await createWordnikSource(baseOptions({ fetchImpl })).fetch("laser");
    expect(result.status).toBe("unavailable");
  });

  it("skips upstream entirely when no API key is configured", async () => {
    const fetchImpl = vi.fn();
    const source = createWordnikSource(baseOptions({ apiKey: undefined, fetchImpl }));
    const result = await source.fetch("laser");
    expect(result).toEqual({ status: "skipped", reason: "WORDNIK_API_KEY is not configured." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves fresh cache hits without contacting Wordnik", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(wordnikResponse()), { status: 200 }));
    const cache = {
      read: vi.fn().mockResolvedValue({
        status: "fresh",
        valueJson: JSON.stringify({
          version: 1,
          data: { candidates: [{ value: "cached", provenance: "wordnik-synonym" }] },
        }),
      }),
      write: vi.fn(),
    };
    const source = createWordnikSource(baseOptions({ fetchImpl, cache: cache as never }));
    const result = await source.fetch("laser");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.candidates).toEqual([{ value: "cached", provenance: "wordnik-synonym" }]);
    }
  });

  it("writes successful results to the cache with the injected policy", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(wordnikResponse()), { status: 200 }));
    const write = vi.fn().mockResolvedValue(undefined);
    const cache = { read: vi.fn().mockResolvedValue({ status: "miss" }), write };
    const policy = { freshForMs: 60_000, retainForMs: 240_000 };
    const source = createWordnikSource(
      baseOptions({ fetchImpl, cache: cache as never, cachePolicy: policy }),
    );
    await source.fetch("laser");

    expect(write).toHaveBeenCalledTimes(1);
    const [family, key, valueJson, usedPolicy] = write.mock.calls[0] as unknown as [
      string,
      string,
      string,
      typeof policy,
    ];
    expect(family).toBe("wordnik");
    expect(key).toContain("laser");
    expect(usedPolicy).toEqual(policy);
    const parsed = JSON.parse(valueJson) as { version: number; data: { candidates: unknown[] } };
    expect(parsed.version).toBe(1);
    expect(parsed.data.candidates).toHaveLength(4);
  });

  it("still succeeds when the cache write fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(wordnikResponse()), { status: 200 }));
    const cache = {
      read: vi.fn().mockRejectedValue(new Error("db down")),
      write: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const source = createWordnikSource(baseOptions({ fetchImpl, cache: cache as never }));
    const result = await source.fetch("laser");
    expect(result.status).toBe("ok");
  });
});
