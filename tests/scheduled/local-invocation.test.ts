import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Task 7.4: verify local one-shot invocation of every scheduled Function.
 * Run with: pnpm vitest run tests/scheduled/local-invocation.test.ts
 * See docs/scheduled-functions.md for the workflow.
 */

const availability = await import("../../netlify/functions/prune-availability-cache");
const language = await import("../../netlify/functions/prune-language-cache");
const ai = await import("../../netlify/functions/prune-ai-cache");
const authData = await import("../../netlify/functions/prune-auth-data");

let dir: string;
const previousUrl = process.env.DATABASE_URL;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "isittaken-scheduled-"));
  process.env.DATABASE_URL = `file:${join(dir, "local.db")}`;
  process.env.LOG_LEVEL = "error";
});

afterAll(() => {
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("local one-shot invocation of scheduled functions", () => {
  it("availability shard runs once against a local SQLite database", async () => {
    await expect(availability.runOnce(Date.now())).resolves.toBeUndefined();
  });

  it("language shard runs once", async () => {
    await expect(language.runOnce(Date.now())).resolves.toBeUndefined();
  });

  it("AI shard runs once", async () => {
    await expect(ai.runOnce(Date.now())).resolves.toBeUndefined();
  });

  it("authentication-data shard runs once", async () => {
    await expect(authData.runOnce(Date.now())).resolves.toBeUndefined();
  });

  it("second invocation of every shard is safe (idempotent)", async () => {
    await expect(availability.runOnce(Date.now())).resolves.toBeUndefined();
    await expect(language.runOnce(Date.now())).resolves.toBeUndefined();
    await expect(ai.runOnce(Date.now())).resolves.toBeUndefined();
    await expect(authData.runOnce(Date.now())).resolves.toBeUndefined();
  });
});
