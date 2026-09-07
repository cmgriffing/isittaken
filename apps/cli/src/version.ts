/**
 * CLI version. Kept in sync with apps/cli/package.json (see tests/version.test.ts).
 * Not imported from package.json at runtime so the published bin has no JSON
 * import-attribute dependency.
 */
export const CLI_VERSION = "0.1.0";
