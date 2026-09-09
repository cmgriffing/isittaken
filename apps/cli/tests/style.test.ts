import { describe, expect, it } from "vitest";
import { createTheme, detectColor } from "../src/style.js";

describe("detectColor", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it("colors only when the stream is a TTY", () => {
    expect(detectColor(tty, {})).toBe(true);
    expect(detectColor(pipe, {})).toBe(false);
    expect(detectColor(undefined, {})).toBe(false);
  });

  it("NO_COLOR wins over FORCE_COLOR and TTY", () => {
    expect(detectColor(tty, { NO_COLOR: "1" })).toBe(false);
    expect(detectColor(tty, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });

  it("FORCE_COLOR forces color on non-TTY streams", () => {
    expect(detectColor(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(detectColor(pipe, { FORCE_COLOR: "2" })).toBe(true);
    // Empty / "0" / "false" do not force.
    expect(detectColor(pipe, { FORCE_COLOR: "" })).toBe(false);
    expect(detectColor(pipe, { FORCE_COLOR: "0" })).toBe(false);
    expect(detectColor(pipe, { FORCE_COLOR: "false" })).toBe(false);
  });

  it("empty NO_COLOR does not disable", () => {
    expect(detectColor(tty, { NO_COLOR: "" })).toBe(true);
  });
});

describe("createTheme", () => {
  it("wraps text when enabled", () => {
    const theme = createTheme(true);
    expect(theme.green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(theme.status("taken", "taken")).toBe("\x1b[31mtaken\x1b[0m");
    expect(theme.status("unknown", "unknown")).toBe("\x1b[33munknown\x1b[0m");
    expect(theme.status("invalid", "invalid")).toBe("\x1b[2minvalid\x1b[0m");
    expect(theme.fuzzy(" (fuzzy)")).toBe("\x1b[36m (fuzzy)\x1b[0m");
  });

  it("returns text unchanged when disabled", () => {
    const theme = createTheme(false);
    expect(theme.green("ok")).toBe("ok");
    expect(theme.bold("x")).toBe("x");
    expect(theme.status("available", "available")).toBe("available");
    expect(theme.fuzzy(" (fuzzy)")).toBe(" (fuzzy)");
  });
});
