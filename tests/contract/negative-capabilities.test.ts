import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "../helpers/test-context";

/**
 * Task 9.3: the initial application exposes no WebMCP draft API, no npm
 * scope endpoint, and no package-inside-scope behavior.
 */

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const root = join(import.meta.dirname, "../..");

describe("negative capability guarantees", () => {
  it("registers no WebMCP browser API or draft adapter anywhere in app code", () => {
    const sourceFiles = [
      ...walk(join(root, "src")),
      ...walk(join(root, "netlify/functions")),
    ].filter((file) => /\.(ts|tsx|astro|mjs)$/.test(file));

    // Draft-API identifiers and tool-registration calls; prose comments
    // mentioning the future adapter are fine.
    const forbidden = [/modelContext/, /registerTool/i, /window\.agent\b/, /navigator\.ai\b/];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(content, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("exposes no npm scope or inside-scope endpoints", () => {
    const toml = readFileSync(join(root, "netlify.toml"), "utf8");
    expect(toml).not.toMatch(/scope/i);

    const functionFiles = readdirSync(join(root, "netlify/functions"));
    const allowed = new Set([
      "search.ts",
      "check.ts",
      "creative-search.ts",
      "auth-github-start.ts",
      "auth-github-callback.ts",
      "auth-session.ts",
      "auth-logout.ts",
      "prune-availability-cache.ts",
      "prune-language-cache.ts",
      "prune-ai-cache.ts",
      "prune-auth-data.ts",
    ]);
    for (const file of functionFiles) {
      if (file.endsWith(".d.ts") || file === "package.json") continue;
      expect(allowed, `unexpected function file: ${file}`).toContain(file);
    }
  });

  it("rejects scoped targets with an explicit unsupported response and no upstream calls", async () => {
    const fetchImpl = vi.fn();
    const context = await createTestContext({ fetchImpl });
    try {
      const ctx = context.ctx;
      const searchHandler = (await import("../../src/functions/search")).createSearchFunction(ctx);

      const scopedRequests = [
        { seed: "@scope/pkg" },
        { seed: "a/b" },
        { seed: "ok", injectedSynonyms: ["@scope/name"] },
      ];
      for (const body of scopedRequests) {
        const response = await searchHandler(
          new Request("http://localhost/api/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
        const payload = (await response.json()) as { error: { code: string } };
        expect(payload.error.code).toBe("unsupported_scope");
      }
      // No inferred or scraped availability check ever happened.
      expect(fetchImpl).not.toHaveBeenCalled();

      // The registry adapter itself also refuses scoped names.
      expect(ctx.serverRegistries.get("npm")?.validate("@scope/pkg")).toMatchObject({
        ok: false,
      });
    } finally {
      context.cleanup();
    }
  });
});
