import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

describe("application shell", () => {
  it("builds pages as static output with a Preact integration", async () => {
    const configModule = await import("../astro.config.mjs");
    const config = configModule.default;
    expect(config.output).toBe("static");
    expect(config.integrations).toHaveLength(1);
  });

  it("routes standalone Functions that claim friendly /api paths", () => {
    // The Netlify config lives at the repository root: the site's base
    // directory is the root, so every path in it is root-relative.
    const toml = readFileSync(
      fileURLToPath(new URL("../../../netlify.toml", import.meta.url)),
      "utf8",
    );
    expect(toml).toContain('publish = "apps/web/dist"');
    expect(toml).toContain('directory = "apps/web/netlify/functions"');
    // Unmatched API paths must not fall through to static assets.
    expect(toml).toContain('from = "/api/*"');

    const functionsDir = fileURLToPath(new URL("../netlify/functions", import.meta.url));
    const declared = (file: string) => {
      const source = readFileSync(join(functionsDir, file), "utf8");
      const match = /path:\s*"([^"]+)"/.exec(source);
      expect(match, `${file} must declare config.path`).toBeTruthy();
      return match?.[1] as string;
    };
    expect(declared("search.ts")).toBe("/api/search");
    expect(declared("creative-search.ts")).toBe("/api/creative-search");
    expect(declared("auth-session.ts")).toBe("/api/auth/session");
  });

  it("exposes the required package scripts", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };
    for (const script of ["dev", "build", "test", "lint", "typecheck", "migrate"]) {
      expect(pkg.scripts?.[script], `script: ${script}`).toBeTruthy();
    }
  });

  it("runs migrations during the Netlify build and keeps local builds database-free", () => {
    const toml = readFileSync(
      fileURLToPath(new URL("../../../netlify.toml", import.meta.url)),
      "utf8",
    );
    const command = /command\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    // The deploy is the migration gate: core first (fresh environments have no
    // dist output), then migrate, then build — in that order.
    expect(command).toBe(
      "pnpm --filter @isittaken/core run build && pnpm --filter @isittaken/web run migrate && pnpm --filter @isittaken/web run build",
    );

    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.build, "local build script must not migrate").not.toContain("migrate");
  });
});
