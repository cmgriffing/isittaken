import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.js";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("CLI_VERSION", () => {
  it("stays in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
