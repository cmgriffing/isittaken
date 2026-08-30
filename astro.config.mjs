// @ts-check
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import netlify from "@netlify/vite-plugin";

// https://astro.build/config
export default defineConfig({
  // Static output: every page is prebuilt HTML; no per-request SSR.
  output: "static",
  integrations: [preact()],
  vite: {
    plugins: [
      // This project uses standalone Netlify Functions only — no Edge
      // Functions — so skip the Deno-based edge dev server entirely.
      netlify({ edgeFunctions: { enabled: false } }),
    ],
  },
});
