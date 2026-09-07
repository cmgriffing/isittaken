import { describe, expect, it, vi } from "vitest";
import { createNpmRegistry } from "@isittaken/core";
import { runCheck, type CheckJsonPayload } from "../src/check.js";
import { REPO_URL } from "../src/repo-info.js";
import { availableAt, captureOut, fakeRegistry, npmValidate, pypiValidate } from "./helpers.js";

const clock = { nowMs: () => 9_000 };

describe("scoped-name failure isolation (real core adapters)", () => {
  it("classifies foo/bar as invalid on npm without aborting the run", async () => {
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["foo/bar", "fzy-pic"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm", "pypi"] },
      {
        clock,
        out,
        registries: [
          fakeRegistry({
            id: "npm",
            validate: npmValidate,
            results: { "fzy-pic": availableAt(1) },
          }),
          fakeRegistry({
            id: "pypi",
            validate: pypiValidate,
            results: { "foo/bar": availableAt(2), "fzy-pic": availableAt(3) },
          }),
        ],
      },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    expect(payload.candidates).toHaveLength(2);

    const scopedNpm = payload.candidates[0]?.results.npm;
    expect(scopedNpm?.status).toBe("invalid");
    expect(scopedNpm?.reason).toMatch(/[Ss]coped|[Nn]ames/);
    // Venues that accept qualified identifiers still produce non-invalid
    // results for the scoped name.
    expect(payload.candidates[0]?.results.pypi?.status).toBe("available");

    const other = payload.candidates[1]?.results;
    expect(other?.npm?.status).toBe("available");
    expect(other?.pypi?.status).toBe("available");
  });
});

describe("phrase normalization end-to-end (real npm adapter + fake fetch)", () => {
  it("normalizes 'fuzzy picker' to fuzzy-picker and reports availability", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const { lines, out } = captureOut();
    const code = await runCheck(
      ["fuzzy picker"],
      { json: true, concurrency: 2, timeoutMs: 100, registries: ["npm"] },
      {
        clock,
        out,
        registries: [
          createNpmRegistry({
            origin: "https://registry.npmjs.org",
            timeoutMs: 100,
            clock,
            version: "1.2.3",
            repoUrl: REPO_URL,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          }),
        ],
      },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(lines[0] ?? "{}") as CheckJsonPayload;
    const npm = payload.candidates[0]?.results.npm;
    expect(npm?.status).toBe("available");
    expect(npm?.name).toBe("fuzzy-picker");

    // The shared fetch helper injected the identifying User-Agent.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe(
      "isittaken/1.2.3 (+https://github.com/cmgriffing/isittaken)",
    );
    expect(headers.get("accept")).toBe("application/json");
  });
});
