// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".astro/**",
      ".netlify/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Client islands must never pull server configuration or secrets into
    // client bundles.
    files: ["src/islands/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/config/server*", "**/config/server/**"],
              message:
                "Server configuration (and its secrets) must not be imported into client islands.",
            },
          ],
        },
      ],
    },
  },
  {
    // Registry descriptors are the client-safe spine shared by server
    // adapters, islands, and future MCP tooling. They must stay free of
    // server-only modules (configuration, secrets, database, adapters).
    files: ["src/domain/registries/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/config/**", "**/db/**", "**/adapters/**", "**/functions/**"],
              message:
                "Registry descriptors are client-safe and must not import server-only modules.",
            },
          ],
        },
      ],
    },
  },
);
