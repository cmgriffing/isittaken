import { describe, expect, it } from "vitest";
import { runCheck, type CheckJsonPayload } from "../src/check.js";
import {
  availableAt,
  captureOut,
  fakeRegistry,
  npmValidate,
  pypiValidate,
  takenAt,
  unknownAt,
} from "./helpers.js";

const clock = { nowMs: () => 5_000 };

describe("runCheck exit codes", () => {
  it("returns 0 when at least one result is available", async () => {
    const code = await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm", "pypi"] },
      {
        clock,
        registries: [
          fakeRegistry({ id: "npm", results: { myname: takenAt(1) } }),
          fakeRegistry({ id: "pypi", results: { myname: availableAt(2) } }),
        ],
      },
    );
    expect(code).toBe(0);
  });

  it("returns 0 when the only available result is fuzzy", async () => {
    const code = await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["maven"] },
      {
        clock,
        registries: [
          fakeRegistry({
            id: "maven",
            results: {
              myname: { status: "available", checkedAtMs: 1, fuzzy: true, reason: "search index" },
            },
          }),
        ],
      },
    );
    expect(code).toBe(0);
  });

  it("returns 1 when every result is taken", async () => {
    const code = await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      { clock, registries: [fakeRegistry({ id: "npm", results: { myname: takenAt(1) } })] },
    );
    expect(code).toBe(1);
  });

  it("returns 1 when every result is unknown", async () => {
    const code = await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        registries: [fakeRegistry({ id: "npm", results: { myname: unknownAt(1, "rate limit") } })],
      },
    );
    expect(code).toBe(1);
  });

  it("returns 1 on a mixed taken/invalid/unknown run", async () => {
    const code = await runCheck(
      ["foo/bar", "gone", "flaky"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        registries: [
          fakeRegistry({
            id: "npm",
            validate: npmValidate,
            results: {
              gone: takenAt(1),
              flaky: unknownAt(2, "blocked"),
            },
          }),
        ],
      },
    );
    expect(code).toBe(1);
  });
});

describe("runCheck JSON output", () => {
  it("emits the documented JSON shape with canonical venue order", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["pypi", "npm"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({ id: "npm", results: { myname: availableAt(11) } }),
          fakeRegistry({
            id: "pypi",
            results: {
              myname: { status: "taken", checkedAtMs: 12, fuzzy: true, reason: "search index" },
            },
          }),
        ],
      },
    );

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.venues).toEqual(["npm", "pypi"]);
    expect(payload.candidates).toEqual([
      {
        input: "myname",
        results: {
          npm: { status: "available", name: "myname", checkedAtMs: 11 },
          pypi: {
            status: "taken",
            name: "myname",
            checkedAtMs: 12,
            fuzzy: true,
            reason: "search index",
          },
        },
      },
    ]);
    // The `registry` field must not leak into map values.
    for (const value of Object.values(payload.candidates[0]?.results ?? {})) {
      expect(Object.keys(value)).not.toContain("registry");
    }
    // The agent-facing summary rollup.
    expect(payload.summary.anyAvailable).toBe(true);
    expect(payload.summary.available).toEqual([
      { input: "myname", venues: ["npm"], fuzzyVenues: [] },
    ]);
  });

  it("omits fuzzy/reason when the venue did not provide them", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["x"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      { clock, out, registries: [fakeRegistry({ id: "npm", results: { x: availableAt(1) } })] },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    const npm = payload.candidates[0]?.results.npm;
    expect(npm).toEqual({ status: "available", name: "x", checkedAtMs: 1 });
    expect("fuzzy" in (npm ?? {})).toBe(false);
    expect("reason" in (npm ?? {})).toBe(false);
  });

  it("keeps the original input (including spaces) as the candidate key", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["fuzzy picker"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({
            id: "npm",
            validate: npmValidate,
            results: { "fuzzy-picker": availableAt(1) },
          }),
        ],
      },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.candidates[0]?.input).toBe("fuzzy picker");
    expect(payload.candidates[0]?.results.npm?.name).toBe("fuzzy-picker");
  });
});

describe("runCheck JSON summary", () => {
  it("rolls up availability with exact vs fuzzy venue split", async () => {
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["fresh", "gone", "fuzzy-only", "blocked"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({
            id: "npm",
            results: {
              fresh: availableAt(1),
              gone: takenAt(2),
              "fuzzy-only": takenAt(3),
              blocked: unknownAt(4, "rate limit"),
            },
          }),
          fakeRegistry({
            id: "maven",
            results: {
              fresh: { status: "available", checkedAtMs: 5, fuzzy: true, reason: "search" },
              gone: takenAt(6),
              "fuzzy-only": {
                status: "available",
                checkedAtMs: 7,
                fuzzy: true,
                reason: "search",
              },
              blocked: unknownAt(8, "rate limit"),
            },
          }),
        ],
      },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    // counts across every (input, venue) pair: 8 results total.
    expect(payload.summary.counts).toEqual({
      available: 3,
      taken: 3,
      invalid: 0,
      unknown: 2,
    });
    // available: 3 (fresh-npm, fresh-maven-fuzzy, fuzzy-only-maven-fuzzy)
    expect(payload.summary.anyAvailable).toBe(true);
    expect(payload.summary.available).toEqual([
      // canonical scope order: npm before maven
      { input: "fresh", venues: ["npm"], fuzzyVenues: ["maven"] },
      { input: "fuzzy-only", venues: [], fuzzyVenues: ["maven"] },
    ]);
    // Unavailable inputs are not listed.
    expect(payload.summary.available.some((e) => e.input === "gone")).toBe(false);
    expect(payload.summary.available.some((e) => e.input === "blocked")).toBe(false);
  });

  it("reports an empty rollup when nothing is available", async () => {
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["gone"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      { clock, out, registries: [fakeRegistry({ id: "npm", results: { gone: takenAt(1) } })] },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.summary).toEqual({
      anyAvailable: false,
      counts: { available: 0, taken: 1, invalid: 0, unknown: 0 },
      available: [],
    });
    expect(code).toBe(1);
  });
});

describe("runCheck human verdict lines", () => {
  it("appends per-input verdicts after the table", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["fresh", "gone"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({ id: "npm", results: { fresh: availableAt(1), gone: takenAt(2) } }),
          fakeRegistry({
            id: "maven",
            results: {
              fresh: { status: "available", checkedAtMs: 3, fuzzy: true, reason: "search" },
              gone: takenAt(4),
            },
          }),
        ],
      },
    );
    const text = lines.join("\n");
    expect(text).toContain("┌─ fresh "); // block per input comes first
    const verdicts = lines.slice(1).filter((line) => line.length > 0);
    expect(verdicts).toContain(
      "fresh: available on: npm; fuzzy leads: maven (verify before relying)",
    );
    // Fully-unavailable inputs get no verdict line (the block shows them).
    expect(verdicts.some((line) => line.startsWith("gone:"))).toBe(false);
  });

  it("prints a no-availability verdict when nothing is available", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["gone"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      { clock, out, registries: [fakeRegistry({ id: "npm", results: { gone: takenAt(1) } })] },
    );
    expect(lines[lines.length - 1]).toBe("no available names found.");
  });
});

describe("runCheck progress (non-JSON only)", () => {
  function captureProgress(): { lines: string[]; progress: (line: string) => void } {
    const lines: string[] = [];
    return { lines, progress: (line) => lines.push(line) };
  }

  it("reports venue-by-venue checkpoints on the progress sink", async () => {
    const { out } = captureOut();
    const { lines: progressLines, progress } = captureProgress();
    await runCheck(
      ["fresh", "gone"],
      { json: false, concurrency: 3, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        progress,
        registries: [
          fakeRegistry({ id: "npm", results: { fresh: availableAt(1), gone: takenAt(2) } }),
          fakeRegistry({
            id: "maven",
            results: {
              fresh: { status: "available", checkedAtMs: 3, fuzzy: true, reason: "search" },
              gone: unknownAt(4, "rate limit"),
            },
          }),
        ],
      },
    );

    expect(progressLines[0]).toContain("checking 2 venues for 2 names (concurrency 3)");
    expect(progressLines.some((line) => /^\[1\/2\] npm — 1 available, 1 taken \(/.test(line))).toBe(
      true,
    );
    expect(
      progressLines.some((line) => /^\[2\/2\] maven — 1 available, 1 unknown \(/.test(line)),
    ).toBe(true);
    // Every checkpoint carries a duration.
    for (const line of progressLines.slice(1)) {
      expect(line).toMatch(/\((\d+ms|\d+\.\ds)\)$/);
    }
    // Progress never leaks into the stdout payload.
    expect(out).toBeDefined();
    expect(progressLines.join("\n")).not.toContain("available on:");
  });

  it("emits no progress in JSON mode", async () => {
    const { lines, out } = captureOut();
    const { lines: progressLines, progress } = captureProgress();
    await runCheck(
      ["x"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        out,
        progress,
        registries: [fakeRegistry({ id: "npm", results: { x: availableAt(1) } })],
      },
    );
    expect(progressLines).toHaveLength(0);
    // The JSON document on stdout is unaffected.
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.candidates[0]?.results.npm?.status).toBe("available");
  });

  it("keeps per-candidate results identical to a single multi-venue call", async () => {
    const { lines, out } = captureOut();
    const { lines: _progressLines, progress } = captureProgress();
    await runCheck(
      ["fresh", "gone"],
      { json: true, concurrency: 3, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        progress,
        registries: [
          fakeRegistry({ id: "npm", results: { fresh: availableAt(1), gone: takenAt(2) } }),
          fakeRegistry({ id: "maven", results: { fresh: availableAt(3), gone: availableAt(4) } }),
        ],
      },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    // Venue order within each candidate is the canonical scope order.
    expect(Object.keys(payload.candidates[0]?.results ?? {})).toEqual(["npm", "maven"]);
    expect(Object.keys(payload.candidates[1]?.results ?? {})).toEqual(["npm", "maven"]);
    // fresh: npm + maven; gone: maven only (npm taken) = 3 available of 4.
    expect(payload.summary.counts.available).toBe(3);
    expect(payload.summary.counts.taken).toBe(1);
  });
});

describe("runCheck human block output (vertical, bordered)", () => {
  it("renders one bordered vertical block per input, escape-free by default", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["gone", "open"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        color: false,
        registries: [
          fakeRegistry({
            id: "npm",
            results: { gone: takenAt(1), open: availableAt(2) },
          }),
          fakeRegistry({
            id: "maven",
            results: {
              gone: { status: "available", checkedAtMs: 3, fuzzy: true, reason: "search" },
              open: { status: "taken", checkedAtMs: 4, fuzzy: true, reason: "search" },
            },
          }),
        ],
      },
    );

    const text = lines.join("\n");
    // Vertical layout: a titled, bordered block per input.
    expect(text).toContain("┌─ gone ");
    expect(text).toContain("┌─ open ");
    expect(text).toContain("└");
    expect(text).toContain("│");
    // Venue rows stacked under each title, fuzzy rendered distinctly.
    expect(text).toMatch(/npm\s+available/);
    expect(text).toMatch(/maven\s+available \(fuzzy\)/);
    expect(text).toMatch(/maven\s+taken \(fuzzy\)/);
    // Reasons are surfaced in the vertical layout.
    expect(text).toContain("· search");
    // No ANSI escapes unless color is enabled.
    expect(text).not.toContain("\x1b[");
    // Verdicts still follow the blocks.
    expect(text).toContain("gone: fuzzy leads: maven (verify before relying)");
    expect(text).toContain("open: available on: npm");
  });

  it("colors statuses and titles when color is enabled", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["mixed"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["npm", "maven"] },
      {
        clock,
        out,
        color: true,
        registries: [
          fakeRegistry({
            id: "npm",
            results: {
              mixed: availableAt(1),
            },
          }),
          fakeRegistry({
            id: "maven",
            results: {
              mixed: unknownAt(2, "rate limit"),
            },
          }),
        ],
      },
    );

    const text = lines.join("\n");
    expect(text).toContain("\x1b[1m"); // bold block title
    expect(text).toContain("\x1b[32m"); // green available
    expect(text).toContain("\x1b[33m"); // yellow unknown
    expect(text).toContain("\x1b[0m"); // resets
  });

  it("marks fuzzy leads with the cyan marker when color is enabled", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["lead"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["maven"] },
      {
        clock,
        out,
        color: true,
        registries: [
          fakeRegistry({
            id: "maven",
            results: {
              lead: { status: "available", checkedAtMs: 3, fuzzy: true, reason: "search" },
            },
          }),
        ],
      },
    );
    const text = lines.join("\n");
    expect(text).toContain("\x1b[36m (fuzzy)"); // cyan fuzzy marker
  });

  it("truncates long reasons to the terminal width", async () => {
    const { lines, out } = captureOut();
    const longReason = "x".repeat(200);
    await runCheck(
      ["truncated"],
      { json: false, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        out,
        color: false,
        columns: 60,
        registries: [
          fakeRegistry({
            id: "npm",
            results: { truncated: unknownAt(1, longReason) },
          }),
        ],
      },
    );
    const row = lines.find((line) => line.includes("npm")) ?? "";
    // The whole row (borders + content) must fit the requested width.
    expect(row.length).toBeLessThanOrEqual(64);
    expect(row).toContain("…");
    expect(row).not.toContain("x".repeat(200));
  });
});

describe("runCheck inputs", () => {
  it("reports every input in a multi-name run without merging them", async () => {
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["fzypic", "fzy-pic"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      { clock, out, registries: [fakeRegistry({ id: "npm", results: { "fzy-pic": takenAt(1) } })] },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates.map((c) => c.input)).toEqual(["fzypic", "fzy-pic"]);
    // fzypic was never scripted -> invalid path is not triggered; it must
    // still receive a result entry (unknown via the fake throwing is not
    // allowed), so script it via defaultResult instead. Here the fake throws
    // for fzypic, which the primitive converts to unknown with a reason.
    expect(code).toBe(1);
    const fzypic = payload.candidates[0]?.results.npm;
    expect(fzypic?.status).toBe("unknown");
    expect(typeof fzypic?.reason).toBe("string");
  });

  it("classifies invalid names per venue without aborting other names", async () => {
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["foo/bar", "fine-name"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm", "pypi"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({
            id: "npm",
            validate: npmValidate,
            results: { "fine-name": availableAt(1) },
          }),
          fakeRegistry({
            id: "pypi",
            validate: pypiValidate,
            results: { "fine-name": availableAt(2) },
          }),
        ],
      },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    const scoped = payload.candidates[0]?.results;
    expect(scoped?.npm?.status).toBe("invalid");
    expect(typeof scoped?.npm?.reason).toBe("string");
    // The other name still received full results.
    expect(payload.candidates[1]?.results.npm?.status).toBe("available");
    expect(payload.candidates[1]?.results.pypi?.status).toBe("available");
    expect(code).toBe(0);
  });
});
