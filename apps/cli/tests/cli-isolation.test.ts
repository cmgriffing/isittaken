import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve roots relative to this test file so the scan never depends on the
// process working directory (turbo may run tests from the repo root).
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const DIST_EXISTS = existsSync(DIST_ROOT);

/**
 * The web app's deployed origins/endpoints the CLI must never target. The CLI
 * fetches registries directly from the user's machine; relaying through these
 * would centralize traffic on our deployed functions (distributed rate
 * limiting must stay impossible by construction, not convention).
 */
const FORBIDDEN_MARKERS = [
  "netlify.app", // the app's deployment host
  "isittaken.com", // the app's custom-domain candidate
  "localhost:4321", // the app's default dev origin (PUBLIC_SITE_URL default)
  "/api/check", // the web app's endpoint paths (the real hazard)
  "/api/search",
  "/api/creative-search",
] as const;

/** The nine venues' real registry origins (positive allowlist for dist). */
const ALLOWED_ORIGINS = new Set([
  "registry.npmjs.org",
  "pypi.org",
  "rubygems.org",
  "hex.pm",
  "search.maven.org",
  "repo1.maven.org",
  "pkg.go.dev",
  "proxy.golang.org",
  "crates.io",
  "api.nuget.org",
  "packagist.org",
  "repo.packagist.org",
]);

/**
 * The one non-registry URL allowed in dist: the User-Agent contact string
 * `isittaken/<version> (+<repo-url>)`. It is never fetched.
 */
const REPO_URL = "https://github.com/cmgriffing/isittaken";

/** Recursively collect files under `root` ending in `ext`, skipping `.map`. */
function collectFiles(root: string, ext: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(ext) && !full.endsWith(".map")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

interface Occurrence {
  file: string;
  line: number;
  marker: string;
}

/** Return every (file, line, marker) hit for the given markers across files. */
function findMarkers(files: string[], markers: readonly string[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const marker of markers) {
        if (line.includes(marker)) {
          found.push({ file, line: idx + 1, marker });
        }
      }
    });
  }
  return found;
}

/** Extract every `http(s)://...` URL literal from the given files. */
function extractUrls(files: string[]): string[] {
  const urls: string[] = [];
  const urlRe = /https?:\/\/[^\s"'`<>]+/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(urlRe)) {
      const url = match[0];
      if (url) urls.push(url);
    }
  }
  return urls;
}

describe("CLI endpoint isolation (D8)", () => {
  const srcFiles = collectFiles(SRC_ROOT, ".ts");
  const distFiles = DIST_EXISTS ? collectFiles(DIST_ROOT, ".js") : [];

  describe("forbidden app origins/endpoints are absent from source and dist", () => {
    it("scans at least the CLI source (dist may be absent pre-build)", () => {
      expect(srcFiles.length).toBeGreaterThan(0);
    });

    it("contains zero occurrences of each forbidden marker", () => {
      const allFiles = [...srcFiles, ...distFiles];
      for (const marker of FORBIDDEN_MARKERS) {
        const hits = findMarkers(allFiles, [marker]);
        const detail = hits.map((h) => `${h.file}:${h.line} contains "${h.marker}"`).join("\n");
        expect(
          hits,
          `forbidden marker "${marker}" found in CLI source/dist:\n${detail}`,
        ).toHaveLength(0);
      }
    });
  });

  describe("every URL literal in dist is a known registry origin", () => {
    it.skipIf(!DIST_EXISTS)("dist URL hosts are all in the registry allowlist", () => {
      const urls = extractUrls(distFiles);
      expect(
        urls.length,
        "no URL literals found in dist — the extraction regex may be broken",
      ).toBeGreaterThan(0);

      for (const url of urls) {
        const parsed = new URL(url);
        if (parsed.hostname === "github.com") {
          // The only allowed non-registry host: the UA contact URL, never fetched.
          expect(
            `${parsed.hostname}${parsed.pathname}`,
            `github.com URL must be exactly ${REPO_URL}, got ${url}`,
          ).toBe("github.com/cmgriffing/isittaken");
        } else {
          expect(
            ALLOWED_ORIGINS.has(parsed.hostname),
            `unexpected origin "${parsed.hostname}" in dist (from ${url})`,
          ).toBe(true);
        }
      }
    });
  });
});
