import { describe, expect, it } from "vitest";
import {
  normalizeAndDedupeCandidates,
  normalizeCandidateValue,
} from "../../../src/domain/normalize-candidates";
import type { RawCandidate } from "../../../src/domain/ports";

const limits = { maxCandidateLength: 64, maxTotalCandidates: 10 };

describe("normalizeCandidateValue", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeCandidateValue("  Laser   Beam ")).toBe("laser beam");
  });

  it("applies unicode NFKC folding", () => {
    expect(normalizeCandidateValue("\uFB01ne")).toBe("fine");
  });
});

describe("normalizeAndDedupeCandidates", () => {
  it("merges equivalent candidates and unions provenance", () => {
    const raw: RawCandidate[] = [
      { value: "Laser", provenance: "input" },
      { value: "laser", provenance: "wordnik-synonym" },
      { value: "LASER", provenance: "injected-creative" },
    ];
    const result = normalizeAndDedupeCandidates(raw, { limits });
    expect(result).toHaveLength(1);
    expect(result[0]?.normalized).toBe("laser");
    expect(result[0]?.provenance).toEqual(["input", "wordnik-synonym", "injected-creative"]);
  });

  it("keeps first-seen order and representative raw value", () => {
    const raw: RawCandidate[] = [
      { value: "beam", provenance: "input" },
      { value: "ray", provenance: "wordnik-related" },
      { value: "BEAM", provenance: "wordnik-synonym" },
    ];
    const result = normalizeAndDedupeCandidates(raw, { limits });
    expect(result.map((c) => c.normalized)).toEqual(["beam", "ray"]);
    expect(result[0]?.raw).toBe("beam");
    expect(result[0]?.provenance).toEqual(["input", "wordnik-synonym"]);
  });

  it("drops empty and over-length values", () => {
    const raw: RawCandidate[] = [
      { value: "   ", provenance: "wordnik-synonym" },
      { value: "x".repeat(65), provenance: "wordnik-related" },
      { value: "good", provenance: "input" },
    ];
    const result = normalizeAndDedupeCandidates(raw, { limits });
    expect(result).toHaveLength(1);
    expect(result[0]?.normalized).toBe("good");
  });

  it("truncates the merged set to the total candidate limit", () => {
    const raw: RawCandidate[] = Array.from({ length: 15 }, (_, i) => ({
      value: `word-${i}`,
      provenance: "wordnik-synonym" as const,
    }));
    const result = normalizeAndDedupeCandidates(raw, {
      limits: { ...limits, maxTotalCandidates: 10 },
    });
    expect(result).toHaveLength(10);
    expect(result[0]?.normalized).toBe("word-0");
    expect(result[9]?.normalized).toBe("word-9");
  });

  it("does not mutate shared provenance arrays across merges", () => {
    const raw: RawCandidate[] = [
      { value: "dup", provenance: "input" },
      { value: "dup", provenance: "wordnik-synonym" },
      { value: "other", provenance: "input" },
    ];
    const result = normalizeAndDedupeCandidates(raw, { limits });
    expect(result.find((c) => c.normalized === "dup")?.provenance).toEqual([
      "input",
      "wordnik-synonym",
    ]);
    expect(result.find((c) => c.normalized === "other")?.provenance).toEqual(["input"]);
  });
});
