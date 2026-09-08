import { describe, expect, it } from "vitest";
import {
  classifyNotFound,
  classifyExactMatch,
  normalizeRegistryName,
  DEFAULT_MAX_NAME_LENGTH,
  isJsonObject,
  isJsonArray,
  type ClassifyInput,
} from "../src/index.js";

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    name: "demo",
    status: 200,
    json: null,
    text: "",
    ...overrides,
  };
}

describe("normalizeRegistryName (default normalizer)", () => {
  it("trims, collapses whitespace runs to hyphens, and lowercases", () => {
    expect(normalizeRegistryName("  Back End  ")).toEqual({ ok: true, name: "back-end" });
    expect(normalizeRegistryName("Laser")).toEqual({ ok: true, name: "laser" });
  });

  it("validates the composed name conservatively", () => {
    expect(normalizeRegistryName("")).toEqual({
      ok: false,
      reason: expect.stringContaining("empty"),
    });
    expect(normalizeRegistryName("-leading")).toEqual({
      ok: false,
      reason: expect.stringContaining("start with a letter"),
    });
    const long = "a".repeat(DEFAULT_MAX_NAME_LENGTH + 1);
    expect(normalizeRegistryName(long).ok).toBe(false);
  });
});

describe("isJsonObject / isJsonArray", () => {
  it("distinguishes objects from arrays", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonArray([])).toBe(true);
    expect(isJsonArray({})).toBe(false);
  });
});

describe("classifyNotFound", () => {
  it("classifies the documented 404 as available", () => {
    expect(classifyNotFound(input({ status: 404 }))).toEqual({ status: "available" });
  });

  it("classifies a 2xx with a passing shape as taken", () => {
    expect(classifyNotFound(input({ json: { name: "demo" } }))).toEqual({ status: "taken" });
  });

  it("classifies a 2xx that fails the shape as unknown/ambiguous", () => {
    expect(classifyNotFound(input({ json: [] }))).toMatchObject({
      status: "unknown",
      reason: "ambiguous response.",
    });
  });

  it("classifies rate limits and other statuses as unknown", () => {
    expect(classifyNotFound(input({ status: 429 }))).toMatchObject({
      status: "unknown",
      reason: "upstream rate limit exceeded.",
    });
    expect(classifyNotFound(input({ status: 500 }))).toMatchObject({
      status: "unknown",
      reason: "responded with status 500.",
    });
  });
});

describe("classifyExactMatch", () => {
  const candidates = (json: Record<string, unknown>) => (json["docs"] as string[]) ?? [];
  const total = (json: Record<string, unknown>) =>
    typeof json["numFound"] === "number" ? (json["numFound"] as number) : null;
  const retrieved = (json: Record<string, unknown>) => (json["docs"] as string[]).length;

  it("classifies taken when a candidate equals the checked name", () => {
    expect(
      classifyExactMatch(input({ json: { docs: ["demo", "other"], numFound: 2 } }), {
        candidates,
        total,
        retrieved,
      }),
    ).toEqual({ status: "taken" });
  });

  it("classifies available only when the retrieved set is complete and empty of matches", () => {
    expect(
      classifyExactMatch(input({ json: { docs: ["other"], numFound: 1 } }), {
        candidates,
        total,
        retrieved,
      }),
    ).toEqual({ status: "available" });
  });

  it("classifies unknown when paginated (retrieved < total)", () => {
    expect(
      classifyExactMatch(input({ json: { docs: ["other"], numFound: 50 } }), {
        candidates,
        total,
        retrieved,
      }),
    ).toMatchObject({ status: "unknown", reason: "inconclusive search results." });
  });

  it("classifies unknown when the body lacks a trustworthy total", () => {
    expect(
      classifyExactMatch(input({ json: { docs: ["other"] } }), {
        candidates,
        total,
        retrieved,
      }),
    ).toMatchObject({ status: "unknown", reason: "inconclusive search results." });
  });

  it("accepts an exact-name match even on an incomplete set (matches win)", () => {
    expect(
      classifyExactMatch(input({ json: { docs: ["demo"], numFound: 50 } }), {
        candidates,
        total,
        retrieved,
      }),
    ).toEqual({ status: "taken" });
  });
});
