import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/program.js";

describe("cli exit-code contract", () => {
  let savedExitCode: number | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  function captureCliStreams(): { stderr: string[]; consoleErrors: string[] } {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    const stderr: string[] = [];
    const consoleErrors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(console, "error").mockImplementation(((message: unknown) => {
      consoleErrors.push(String(message));
      return undefined as unknown as void;
    }) as typeof console.error);
    return { stderr, consoleErrors };
  }

  it("missing names is a usage error: exit 2, message written once", async () => {
    const { stderr } = captureCliStreams();
    await runCli(["node", "isittaken", "check"]);
    expect(process.exitCode).toBe(2);
    const hits = stderr.join("").match(/missing required argument/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it("invalid --concurrency is a usage error: exit 2", async () => {
    const { stderr } = captureCliStreams();
    await runCli(["node", "isittaken", "check", "--concurrency", "0", "foo"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toMatch(/--concurrency must be an integer >= 1/);
  });

  it("invalid --timeout is a usage error: exit 2", async () => {
    const { stderr } = captureCliStreams();
    await runCli(["node", "isittaken", "check", "--timeout", "0", "foo"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("")).toMatch(/--timeout must be an integer >= 1/);
  });

  it("unknown venue id is a usage error: exit 2", async () => {
    const { consoleErrors } = captureCliStreams();
    await runCli(["node", "isittaken", "check", "-r", "bogus", "foo"]);
    expect(process.exitCode).toBe(2);
    expect(consoleErrors.join("\n")).toMatch(/unknown venue id\(s\): bogus/);
  });

  it("--help exits 0 (root and subcommand)", async () => {
    captureCliStreams();
    await runCli(["node", "isittaken", "--help"]);
    expect(process.exitCode).toBe(0);
    await runCli(["node", "isittaken", "check", "--help"]);
    expect(process.exitCode).toBe(0);
  });

  it("--version exits 0", async () => {
    const { stderr } = captureCliStreams();
    await runCli(["node", "isittaken", "--version"]);
    expect(process.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
  });
});
