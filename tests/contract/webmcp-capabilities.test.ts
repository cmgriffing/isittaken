import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestContext } from "../helpers/test-context";

/**
 * Positive capability guarantees (flipped from the original prohibition in
 * this same file): WebMCP tool registration ships via the adapter module,
 * with an exact tool lineup, registered from the home page only. Scope
 * behavior remains unsupported.
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

/** The four declared tool names, exactly and only these. */
const DECLARED_TOOLS = [
  "list_registries",
  "search_names",
  "check_availability",
  "batch_check_availability",
] as const;

describe("WebMCP capability guarantees", () => {
  it("registers draft-API tools only from the dedicated adapter module", () => {
    const sourceFiles = [
      ...walk(join(root, "src")),
      ...walk(join(root, "netlify/functions")),
    ].filter((file) => /\.(ts|tsx|astro|d\.ts)$/.test(file));

    const adapterDir = join(root, "src/lib/client/webmcp");
    for (const file of sourceFiles) {
      const inAdapter = file.startsWith(adapterDir);
      const content = readFileSync(file, "utf8");
      for (const pattern of [/registerTool/, /document\.modelContext/]) {
        expect(
          inAdapter || !pattern.test(content),
          `${file} uses draft-API identifier ${pattern} outside the adapter`,
        ).toBe(true);
      }
      // window.agent / navigator.ai were never part of this app.
      for (const pattern of [/window\.agent\b/, /navigator\.ai\b/]) {
        expect(content, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("registers exactly the four declared tool names in the adapter", async () => {
    vi.resetModules();
    const { createWebMcpAdapter } = await import("../../src/lib/client/webmcp/adapter");
    const store = await import("../../src/lib/client/search-store");
    store.resetSearchStoreForTests();
    const registered: string[] = [];
    const adapter = createWebMcpAdapter({
      getModelContext: () => ({
        registerTool: (tool: { name: string }) => {
          registered.push(tool.name);
        },
      }),
    });
    adapter.register();
    expect(registered.sort()).toEqual([...DECLARED_TOOLS].sort());
    store.resetSearchStoreForTests();
  });

  it("registers tools from the home page only", () => {
    const pagesDir = join(root, "src/pages");
    const pages = walk(pagesDir).filter((file) => /\.astro$/.test(file));
    const withRegistration = pages.filter((file) =>
      readFileSync(file, "utf8").includes("registerWebMcpTools"),
    );
    expect(withRegistration).toEqual([join(pagesDir, "index.astro")]);
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
