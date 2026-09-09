import { VENUE_IDS, isVenueId, type VenueId } from "@isittaken/core";
import type { CheckFlags } from "./check.js";

export type ParseResult =
  { ok: true; inputs: string[]; flags: CheckFlags } | { ok: false; error: string };

export type IntParseResult = { ok: true; value: number } | { ok: false; error: string };

export type RegistryIdsResult = { ok: true; ids: VenueId[] } | { ok: false; error: string };

const USAGE_HINT =
  "usage: isittaken check <names...> [--json] [-r <venue-ids>] [--concurrency <n>] [--timeout <ms>]";

/**
 * Parse a positive integer flag value (`--concurrency`, `--timeout`).
 * Shared by the pure parser and the Commander option parsers so error
 * messages stay identical on every path.
 */
export function parsePositiveInt(raw: string, label: string): IntParseResult {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${label} must be an integer >= 1 (received "${raw}").` };
  }
  return { ok: true, value };
}

/**
 * Parse and validate a comma-separated venue id list: trims parts, drops
 * empties, rejects unknown ids with the supported list, dedupes repeats in
 * first-seen order.
 */
export function parseRegistryIds(raw: string): RegistryIdsResult {
  const parts = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (parts.length === 0) {
    return {
      ok: false,
      error: `--registry requires at least one venue id. supported venues: ${VENUE_IDS.join(", ")}`,
    };
  }
  const valid: VenueId[] = [];
  const unknown: string[] = [];
  for (const id of parts) {
    if (isVenueId(id)) valid.push(id);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown venue id(s): ${unknown.join(", ")}. supported venues: ${VENUE_IDS.join(", ")}`,
    };
  }
  return { ok: true, ids: [...new Set(valid)] };
}

const VALUE_FLAGS = new Set(["-r", "--registry", "--concurrency", "--timeout"]);

/**
 * Pure argv parser for `isittaken check`. Accepts space- and `=`-separated
 * option values and a `--` terminator; every failure carries a usage error
 * message (the CLI prints it to stderr and exits 2).
 */
export function parseCheckArgs(argv: readonly string[]): ParseResult {
  const inputs: string[] = [];
  let scoped: VenueId[] | undefined;
  let json = false;
  let concurrency: number | undefined;
  let timeoutMs: number | undefined;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (positionalOnly || !arg.startsWith("-") || arg === "-") {
      inputs.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    let value = equals === -1 ? undefined : arg.slice(equals + 1);

    if (VALUE_FLAGS.has(name) && value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        return { ok: false, error: `option ${name} requires a value. ${USAGE_HINT}` };
      }
      value = next;
      index += 1;
    }

    switch (name) {
      case "-r":
      case "--registry": {
        const parsed = parseRegistryIds(value ?? "");
        if (!parsed.ok) return parsed;
        scoped = parsed.ids;
        break;
      }
      case "--json":
        if (value !== undefined && value !== "true" && value !== "false") {
          return { ok: false, error: `--json does not take a value. ${USAGE_HINT}` };
        }
        json = value === undefined || value === "true";
        break;
      case "--concurrency": {
        const parsed = parsePositiveInt(value ?? "", "--concurrency");
        if (!parsed.ok) return parsed;
        concurrency = parsed.value;
        break;
      }
      case "--timeout": {
        const parsed = parsePositiveInt(value ?? "", "--timeout");
        if (!parsed.ok) return parsed;
        timeoutMs = parsed.value;
        break;
      }
      default:
        return { ok: false, error: `unknown option: ${name}. ${USAGE_HINT}` };
    }
  }

  if (inputs.length === 0) {
    return { ok: false, error: `provide at least one name to check. ${USAGE_HINT}` };
  }

  return {
    ok: true,
    inputs,
    flags: {
      registries: scoped,
      json,
      concurrency: concurrency ?? 10,
      timeoutMs: timeoutMs ?? 10_000,
    },
  };
}
