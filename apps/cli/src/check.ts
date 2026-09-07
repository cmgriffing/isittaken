import {
  VENUE_IDS,
  checkCandidatesAcrossRegistries,
  normalizeCandidateValue,
  type Clock,
  type PackageRegistry,
  type RegistryResult,
  type RegistryStatus,
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

/** Rollup that lets agents answer "what can I claim?" without scanning venues. */
export interface CheckSummary {
  /** True when at least one (input, venue) result is `available`. */
  anyAvailable: boolean;
  /** Result counts across every (input, venue) pair. */
  counts: Record<RegistryStatus, number>;
  /** Inputs with at least one `available` result, split by certainty. */
  available: { input: string; venues: VenueId[]; fuzzyVenues: VenueId[] }[];
}

export interface CheckJsonPayload {
  venues: VenueId[];
  summary: CheckSummary;
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

  const payload = buildPayload(inputs, scope, results);
  const anyAvailable = payload.summary.anyAvailable;

  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    out(renderTable(payload));
    out("");
    for (const line of renderVerdicts(payload)) out(line);
  }

  return anyAvailable ? 0 : 1;
}

/**
 * Assemble the output payload from raw primitive results: per-input venue
 * maps plus the agent-facing summary rollup.
 */
function buildPayload(
  inputs: readonly string[],
  scope: readonly VenueId[],
  results: readonly RegistryResult[][],
): CheckJsonPayload {
  const counts: Record<RegistryStatus, number> = {
    available: 0,
    taken: 0,
    invalid: 0,
    unknown: 0,
  };
  for (const venueResults of results) {
    for (const result of venueResults) {
      counts[result.status] += 1;
    }
  }

  /** Re-order raw venue ids into canonical scope order. */
  const orderIn = (ids: readonly string[]): VenueId[] =>
    scope.filter((venue) => ids.includes(venue));

  const available: CheckSummary["available"] = [];
  const candidates = inputs.map((input, index) => {
    const byVenue: Record<string, VenueResultJson> = {};
    const exact: string[] = [];
    const fuzzy: string[] = [];
    for (const result of results[index] ?? []) {
      const { registry: _registry, ...rest } = result;
      byVenue[result.registry] = rest;
      if (result.status === "available") {
        (result.fuzzy === true ? fuzzy : exact).push(result.registry);
      }
    }
    if (exact.length > 0 || fuzzy.length > 0) {
      available.push({ input, venues: orderIn(exact), fuzzyVenues: orderIn(fuzzy) });
    }
    return { input, results: byVenue };
  });

  return {
    venues: [...scope],
    summary: { anyAvailable: counts.available > 0, counts, available },
    candidates,
  };
}

/**
 * Trailing verdict lines for the human output — also the friendliest thing
 * for an agent that read the default output instead of `--json`:
 *   <input>: available on npm, pypi; fuzzy leads: maven, go (verify)
 */
function renderVerdicts(payload: CheckJsonPayload): string[] {
  if (payload.summary.available.length === 0) {
    return ["no available names found."];
  }
  return payload.summary.available.map((entry) => {
    const parts: string[] = [];
    if (entry.venues.length > 0) {
      parts.push(`available on: ${entry.venues.join(", ")}`);
    }
    if (entry.fuzzyVenues.length > 0) {
      parts.push(`fuzzy leads: ${entry.fuzzyVenues.join(", ")} (verify before relying)`);
    }
    return `${entry.input}: ${parts.join("; ")}`;
  });
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
