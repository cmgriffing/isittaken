import { describe, expect, it } from "vitest";
import {
  validateSearchRequest,
  type SearchLimits,
} from "../../../src/domain/validate-search-request";
import { SearchValidationError } from "../../../src/domain/errors";

const limits: SearchLimits = {
  maxSeedLength: 32,
  maxInjectedSynonyms: 3,
  maxInjectedCreatives: 3,
  maxCandidateLength: 64,
  maxTotalCandidates: 10,
};

describe("validateSearchRequest", () => {
  it("trims surrounding whitespace from the seed", () => {
    const result = validateSearchRequest({ seed: "  laser  " }, limits);
    expect(result.seed).toBe("laser");
    expect(result.injectedSynonyms).toEqual([]);
    expect(result.injectedCreatives).toEqual([]);
  });

  it("rejects empty and whitespace-only seeds", () => {
    expect(() => validateSearchRequest({ seed: "" }, limits)).toThrowError(SearchValidationError);
    expect(() => validateSearchRequest({ seed: "   " }, limits)).toThrowError(
      SearchValidationError,
    );
  });

  it("rejects missing and non-string seeds", () => {
    expect(() =>
      validateSearchRequest({ seed: undefined as unknown as string }, limits),
    ).toThrowError(SearchValidationError);
    expect(() => validateSearchRequest({ seed: 42 as unknown as string }, limits)).toThrowError(
      SearchValidationError,
    );
  });

  it("rejects over-limit seeds", () => {
    expect(() => validateSearchRequest({ seed: "a".repeat(33) }, limits)).toThrowError(
      /exceeds 32/,
    );
  });

  it("rejects seeds with unsupported characters", () => {
    expect(() => validateSearchRequest({ seed: "hello!" }, limits)).toThrowError(
      SearchValidationError,
    );
    expect(() => validateSearchRequest({ seed: "a\tb" }, limits)).toThrowError(
      SearchValidationError,
    );
  });

  it("explicitly rejects scoped seeds without upstream calls", () => {
    for (const seed of ["@scope/pkg", "a/b", "@types/node"]) {
      try {
        validateSearchRequest({ seed }, limits);
        expect.unreachable(`${seed} should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(SearchValidationError);
        expect((error as SearchValidationError).code).toBe("unsupported_scope");
        expect((error as Error).message).toMatch(/not supported/i);
      }
    }
  });

  it("rejects injected values with invalid characters or scope separators", () => {
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedSynonyms: ["fine", "a/b"] }, limits),
    ).toThrowError(SearchValidationError);
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedCreatives: ["has#hash"] }, limits),
    ).toThrowError(SearchValidationError);
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedSynonyms: ["   "] }, limits),
    ).toThrowError(SearchValidationError);
  });

  it("enforces per-family injected count limits", () => {
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedSynonyms: ["a", "b", "c", "d"] }, limits),
    ).toThrowError(/exceed the limit of 3/);
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedCreatives: ["a", "b", "c", "d"] }, limits),
    ).toThrowError(/exceed the limit of 3/);
  });

  it("enforces the total candidate limit across families", () => {
    const synonyms = Array.from({ length: 3 }, (_, i) => `s${i}`);
    const creatives = Array.from({ length: 3 }, (_, i) => `c${i}`);
    expect(() =>
      validateSearchRequest(
        { seed: "ok", injectedSynonyms: synonyms, injectedCreatives: creatives },
        { ...limits, maxTotalCandidates: 5 },
      ),
    ).toThrowError(/exceeding the limit of 5/);
  });

  it("enforces per-value length limits on injected values", () => {
    expect(() =>
      validateSearchRequest({ seed: "ok", injectedSynonyms: ["x".repeat(65)] }, limits),
    ).toThrowError(/exceeds 64 characters/);
  });

  it("accepts a full valid request", () => {
    const result = validateSearchRequest(
      {
        seed: " laser ",
        injectedSynonyms: ["optics", "beam"],
        injectedCreatives: ["lazerly", "laser-kit"],
      },
      limits,
    );
    expect(result.seed).toBe("laser");
    expect(result.injectedSynonyms).toEqual(["optics", "beam"]);
    expect(result.injectedCreatives).toEqual(["lazerly", "laser-kit"]);
  });
});
