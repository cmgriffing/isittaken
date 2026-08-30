#!/usr/bin/env node
// Verifies the production build shape:
//   - static page HTML and hashed assets exist
//   - standalone Functions sources exist and compile target is configured
//   - NO Astro SSR page handler / server bundle leaked into the output
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const fail = (message) => {
  console.error(`[verify-build] FAIL: ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`[verify-build] ok: ${message}`);

console.log("[verify-build] running astro build...");
execSync("pnpm exec astro build", { stdio: "inherit", cwd: root });

const dist = join(root, "dist");
if (!existsSync(dist)) fail("dist/ is missing");
for (const page of [
  "index.html",
  "404.html",
  "docs/about/index.html",
  "docs/privacy/index.html",
  "docs/methodology/index.html",
]) {
  if (!existsSync(join(dist, page))) fail(`static page missing: ${page}`);
}
ok("static page HTML present (/, 404, docs/*)");

const assets = join(dist, "_astro");
if (!existsSync(assets) || readdirSync(assets).filter((f) => f.endsWith(".js")).length === 0) {
  fail("hashed client assets are missing under dist/_astro");
}
ok("hashed client assets present");

// No SSR handler may leak: Astro SSR emits dist/_worker.js (Vercel-style) or
// a server entry under dist/_server / .netlify functions-internal via the
// adapter. This project intentionally has no Astro adapter.
for (const forbidden of ["_worker.js", "_server", "_serverless"]) {
  if (existsSync(join(dist, forbidden))) fail(`unexpected SSR output: dist/${forbidden}`);
}
const distFiles = readdirSync(dist);
const ssrLike = distFiles.filter((f) => /entry\.server|ssr/i.test(f));
if (ssrLike.length > 0) fail(`unexpected SSR artifacts in dist/: ${ssrLike.join(", ")}`);
ok("no Astro SSR page handler in build output");

// Standalone Functions sources exist.
const functionsDir = join(root, "netlify/functions");
const required = [
  "search.ts",
  "creative-search.ts",
  "auth-github-start.ts",
  "auth-github-callback.ts",
  "auth-session.ts",
  "auth-logout.ts",
  "prune-availability-cache.ts",
  "prune-language-cache.ts",
  "prune-ai-cache.ts",
  "prune-auth-data.ts",
];
for (const fn of required) {
  if (!existsSync(join(functionsDir, fn))) fail(`standalone Function missing: ${fn}`);
}
ok(`all ${required.length} standalone Functions present in netlify/functions`);

// Functions claim friendly /api paths via their config.path export.
const expectedPaths = {
  "search.ts": "/api/search",
  "creative-search.ts": "/api/creative-search",
  "auth-github-start.ts": "/api/auth/github/start",
  "auth-github-callback.ts": "/api/auth/github/callback",
  "auth-session.ts": "/api/auth/session",
  "auth-logout.ts": "/api/auth/logout",
};
for (const [file, route] of Object.entries(expectedPaths)) {
  const source = readFileSync(join(functionsDir, file), "utf8");
  if (!source.includes(`path: "${route}"`)) fail(`${file} does not declare path: "${route}"`);
}
ok("Functions declare friendly /api paths");

console.log(
  "[verify-build] PASS: static pages + assets, no SSR handler, standalone Functions wired.",
);
