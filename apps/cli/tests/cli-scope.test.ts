import { describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import { parseCheckArgs } from "../src/parse.js";
import { availableAt, captureOut, fakeRegistry } from "./helpers.js";
import type { CheckJsonPayload } from "../src/check.js";

const clock = { nowMs: () => 7_000 };

describe("venue scoping", () => {
  it("defaults to all nine venues in canonical order", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100 },
      {
        clock,
        out,
        registries: [
          fakeRegistry({ id: "npm", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "pypi", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "crates", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "rubygems", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "nuget", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "hex", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "maven", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "go", defaultResult: availableAt(1) }),
          fakeRegistry({ id: "packagist", defaultResult: availableAt(1) }),
        ],
      },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.venues).toEqual([
      "npm",
      "pypi",
      "crates",
      "rubygems",
      "nuget",
      "hex",
      "maven",
      "go",
      "packagist",
    ]);
  });

  it("scopes results to the requested venues in canonical order", async () => {
    const { lines, out } = captureOut();
    await runCheck(
      ["myname"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["crates", "npm"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({ id: "npm", results: { myname: availableAt(1) } }),
          fakeRegistry({ id: "crates", results: { myname: availableAt(2) } }),
        ],
      },
    );
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.venues).toEqual(["npm", "crates"]);
    expect(Object.keys(payload.candidates[0]?.results ?? {})).toEqual(["npm", "crates"]);
  });
});

describe("parseCheckArgs scope handling", () => {
  it("dedupes repeated venue ids in first-seen order", () => {
    const parsed = parseCheckArgs(["myname", "-r", "crates,npm,crates"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.flags.registries).toEqual(["crates", "npm"]);
    }
  });

  it("accepts the --registry=<ids> form", () => {
    const parsed = parseCheckArgs(["myname", "--registry=npm,pypi"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.flags.registries).toEqual(["npm", "pypi"]);
    }
  });
});
