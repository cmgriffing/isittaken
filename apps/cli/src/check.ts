import {
  VENUE_IDS,
  checkCandidatesAcrossRegistries,
  normalizeCandidateValue,
  type Clock,
  type PackageRegistry,
  type RegistryResult,
  type VenueId,
} from "@isittaken/core";
import { createClock } from "./clock.js";
import { createRegistries } from "./registries.js";

/** Validated flags for the `check` command (defaults applied by the parser). */
export interface CheckFlags {
  /** Venue scope; omitted means all nine venues (canonical order). */
  registries?: readonly VenueId[];
  /** Emit machine-readable JSON instead of the human table. */
  json: boolean;
  /** Max concurrent upstream lookups per venue. */
  concurrency: number;
  /** Per-venue upstream timeout in milliseconds. */
  timeoutMs: number;
}

export interface CheckDeps {
  /** Override the real venue adapters (tests). */
  registries?: readonly PackageRegistry[];
  /** Override the clock (tests). */
  clock?: Clock;
  /** Output sink (stdout by default). */
  out?: (line: string) => void;
}

/** Per-venue result as emitted in JSON output; the venue id is the map key. */
export interface VenueResultJson {
  status: RegistryResult["status"];
  /** Venue-normalized name actually checked (or rejected). */
  name: string;
  checkedAtMs: number;
  fuzzy?: boolean;
  reason?: string;
}

export interface CheckJsonPayload {
  venues: VenueId[];
  candidates: { input: string; results: Record<string, VenueResultJson> }[];
}

function defaultOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The `check` command core: every input becomes a candidate, venues in scope
 * are checked via the shared primitive, results are rendered (JSON or table),
 * and the exit code is `0` when any (input, venue) result is `available`.
 * Never throws for per-venue problems; only for unexpected internal failures.
 */
export async function runCheck(
  inputs: readonly string[],
  flags: CheckFlags,
  deps: CheckDeps = {},
): Promise<number> {
  const out = deps.out ?? defaultOut;
  const clock = deps.clock ?? createClock();
  const requested = flags.registries ?? [...VENUE_IDS];
  // Canonical venue order regardless of the order ids were passed in.
  const scope = VENUE_IDS.filter((id) => requested.includes(id));

  const registries =
    deps.registries ?? createRegistries(scope, { timeoutMs: flags.timeoutMs, clock });

  const candidates = inputs.map((input) => ({ normalized: normalizeCandidateValue(input) }));

  const results = await checkCandidatesAcrossRegistries(candidates, {
    registries,
    clock,
    registryConcurrency: flags.concurrency,
  });

  const payload: CheckJsonPayload = {
    venues: [...scope],
    candidates: inputs.map((input, index) => {
      const byVenue: Record<string, VenueResultJson> = {};
      for (const result of results[index] ?? []) {
        const { registry: _registry, ...rest } = result;
        byVenue[result.registry] = rest;
      }
      return { input, results: byVenue };
    }),
  };

  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    out(renderTable(payload));
  }

  const anyAvailable = results.some((venueResults) =>
    venueResults.some((result) => result.status === "available"),
  );
  return anyAvailable ? 0 : 1;
}

/**
 * Aligned table: first column is the original input, then one column per
 * venue in scope. Fuzzy results render with a ` (fuzzy)` suffix so leads are
 * visually distinct from definitive verdicts.
 */
function renderTable(payload: CheckJsonPayload): string {
  const header = ["input", ...payload.venues];
  const rows = payload.candidates.map((candidate) => [
    candidate.input,
    ...payload.venues.map((venue) => {
      const result = candidate.results[venue];
      if (!result) return "-";
      return result.fuzzy ? `${result.status} (fuzzy)` : result.status;
    }),
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const lines = [
    header.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  "),
    ...rows.map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    ),
  ];
  return lines.map((line) => line.trimEnd()).join("\n");
}
