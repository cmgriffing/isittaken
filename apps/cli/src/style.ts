import type { RegistryStatus } from "@isittaken/core";

const RESET = "\x1b[0m";

export interface Theme {
  /** True when ANSI escapes are emitted. */
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  /** Status-word coloring for the honest classification vocabulary. */
  status(status: RegistryStatus, text: string): string;
  /** Fuzzy-lead marker (a lead to verify, not a verdict). */
  fuzzy(text: string): string;
}

function paint(code: string, enabled: boolean): (text: string) => string {
  return (text) => (enabled ? `\x1b[${code}m${text}${RESET}` : text);
}

/**
 * Terminal theme. When `enabled` is false every helper returns its input
 * unchanged, so the plain-text shape of the output is byte-identical.
 */
export function createTheme(enabled: boolean): Theme {
  const dim = paint("2", enabled);
  return {
    enabled,
    bold: paint("1", enabled),
    dim,
    green: paint("32", enabled),
    red: paint("31", enabled),
    yellow: paint("33", enabled),
    cyan: paint("36", enabled),
    status(status, text) {
      switch (status) {
        case "available":
          return paint("32", enabled)(text);
        case "taken":
          return paint("31", enabled)(text);
        case "unknown":
          return paint("33", enabled)(text);
        case "invalid":
          return dim(text);
      }
    },
    fuzzy: paint("36", enabled),
  };
}

/**
 * Respect the NO_COLOR / FORCE_COLOR conventions (NO_COLOR wins — the
 * user's explicit opt-out beats a wrapper's opt-in); color only when the
 * target stream is a TTY, so piped output stays escape-free.
 */
export function detectColor(
  stream: { isTTY?: boolean } | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "" && noColor !== "0") {
    return false;
  }
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") {
    return true;
  }
  return stream?.isTTY === true;
}
