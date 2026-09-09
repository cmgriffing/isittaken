import { describe, expect, it } from "vitest";
import { VENUE_IDS } from "@isittaken/core";
import { parseCheckArgs, parsePositiveInt, parseRegistryIds } from "../src/parse.js";

describe("parsePositiveInt", () => {
  it("accepts positive integers", () => {
    expect(parsePositiveInt("1", "--x")).toEqual({ ok: true, value: 1 });
    expect(parsePositiveInt("42", "--x")).toEqual({ ok: true, value: 42 });
  });

  it("rejects zero, negatives, and non-integers", () => {
    for (const bad of ["0", "-3", "abc", "1.5", ""]) {
      const parsed = parsePositiveInt(bad, "--concurrency");
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("--concurrency");
    }
  });
});

describe("parseRegistryIds", () => {
  it("accepts known ids and dedupes", () => {
    const parsed = parseRegistryIds(" npm, pypi ,npm ");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ids).toEqual(["npm", "pypi"]);
  });

  it("rejects unknown ids and lists all supported venues", () => {
    const parsed = parseRegistryIds("pypi,bogus");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("bogus");
      for (const venue of VENUE_IDS) {
        expect(parsed.error).toContain(venue);
      }
    }
  });

  it("rejects an empty list", () => {
    expect(parseRegistryIds("").ok).toBe(false);
    expect(parseRegistryIds("   ").ok).toBe(false);
    expect(parseRegistryIds(",,").ok).toBe(false);
  });
});

describe("parseCheckArgs", () => {
  it("parses names and applies flag defaults", () => {
    const parsed = parseCheckArgs(["fzypic", "fzy-pic", "fuzzy picker"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.inputs).toEqual(["fzypic", "fzy-pic", "fuzzy picker"]);
      expect(parsed.flags.registries).toBeUndefined();
      expect(parsed.flags.json).toBe(false);
      expect(parsed.flags.concurrency).toBe(10);
      expect(parsed.flags.timeoutMs).toBe(10_000);
    }
  });

  it("parses space- and equals-separated option values", () => {
    const parsed = parseCheckArgs([
      "x",
      "-r",
      "npm,crates",
      "--json",
      "--concurrency",
      "5",
      "--timeout=2500",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.flags).toEqual({
        registries: ["npm", "crates"],
        json: true,
        concurrency: 5,
        timeoutMs: 2500,
      });
    }
  });

  it("treats everything after -- as names", () => {
    const parsed = parseCheckArgs(["--", "-weird", "--json"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.inputs).toEqual(["-weird", "--json"]);
  });

  it("requires at least one name", () => {
    const parsed = parseCheckArgs(["--json"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/at least one name/);
  });

  it("rejects unknown venue ids listing the supported venues", () => {
    const parsed = parseCheckArgs(["myname", "-r", "pypi,bogus"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("bogus");
      expect(parsed.error).toContain(VENUE_IDS.join(", "));
    }
  });

  it("rejects an empty registry list", () => {
    expect(parseCheckArgs(["myname", "-r", ""]).ok).toBe(false);
    expect(parseCheckArgs(["myname", "--registry", ",,"]).ok).toBe(false);
  });

  it("rejects invalid numeric flag values", () => {
    for (const argv of [
      ["n", "--concurrency", "0"],
      ["n", "--concurrency", "abc"],
      ["n", "--timeout", "0"],
      ["n", "--concurrency=1.5"],
    ]) {
      const parsed = parseCheckArgs(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/integer >= 1/);
    }
  });

  it("rejects flags with missing values", () => {
    const parsed = parseCheckArgs(["n", "--registry"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/requires a value/);
  });

  it("rejects unknown options", () => {
    const parsed = parseCheckArgs(["n", "--verbose"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--verbose");
  });
});
