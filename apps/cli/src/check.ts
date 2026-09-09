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
import { createTheme, detectColor, type Theme } from "./style.js";

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
  /** Progress sink for non-JSON runs (stderr by default). */
  progress?: (line: string) => void;
  /** Force color on/off (tests); default TTY + NO_COLOR/FORCE_COLOR detection. */
  color?: boolean;
  /** Terminal width for reason truncation (tests); default process.stdout.columns. */
  columns?: number;
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

function defaultProgress(line: string): void {
  process.stderr.write(`${line}\n`);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact per-venue status tally, e.g. `2 available, 1 unknown`. */
function describeStatuses(venueResults: readonly RegistryResult[][]): string {
  const counts: Record<RegistryStatus, number> = {
    available: 0,
    taken: 0,
    invalid: 0,
    unknown: 0,
  };
  for (const result of venueResults.flat()) {
    counts[result.status] += 1;
  }
  const parts = (Object.entries(counts) as [RegistryStatus, number][])
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`);
  return parts.length > 0 ? parts.join(", ") : "no names";
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
  const progress = deps.progress ?? defaultProgress;
  // JSON mode must stay pure machine-readable: no progress on any stream.
  const reportProgress = flags.json ? undefined : progress;
  const theme = createTheme(deps.color ?? detectColor(process.stdout, process.env));
  const columns = deps.columns ?? process.stdout.columns;
  const clock = deps.clock ?? createClock();
  const requested = flags.registries ?? [...VENUE_IDS];
  // Canonical venue order regardless of the order ids were passed in.
  const scope = VENUE_IDS.filter((id) => requested.includes(id));

  const registries =
    deps.registries ?? createRegistries(scope, { timeoutMs: flags.timeoutMs, clock });

  const candidates = inputs.map((input) => ({ normalized: normalizeCandidateValue(input) }));

  if (reportProgress) {
    reportProgress(
      `checking ${scope.length} venue${scope.length === 1 ? "" : "s"} for ` +
        `${inputs.length} name${inputs.length === 1 ? "" : "s"} (concurrency ` +
        `${flags.concurrency})...`,
    );
  }

  // One primitive call per venue: the venues already run sequentially inside
  // the primitive, so this is behavior-identical while making each venue a
  // progress checkpoint. Results are concatenated per candidate in scope
  // order, exactly as a single multi-venue call would produce them.
  const results: RegistryResult[][] = inputs.map(() => []);
  for (const [venueIndex, venue] of scope.entries()) {
    const venueRegistries = registries.filter((registry) => registry.id === venue);
    const startedAtMs = clock.nowMs();
    const venueResults = await checkCandidatesAcrossRegistries(candidates, {
      registries: venueRegistries,
      clock,
      registryConcurrency: flags.concurrency,
    });
    const durationMs = Math.max(0, clock.nowMs() - startedAtMs);
    for (const [candidateIndex, result] of venueResults.entries()) {
      results[candidateIndex]?.push(...result);
    }
    reportProgress?.(
      `[${venueIndex + 1}/${scope.length}] ${venue} — ${describeStatuses(venueResults)} ` +
        `(${formatDuration(durationMs)})`,
    );
  }

  const payload = buildPayload(inputs, scope, results);
  const anyAvailable = payload.summary.anyAvailable;

  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
  } else {
    for (const line of renderBlocks(payload, theme, columns)) out(line);
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

/** Fallback line-width cap when the terminal width is unknown. */
const DEFAULT_MAX_COLUMNS = 100;

/**
 * Vertical report: one bordered block per input, venue rows stacked with
 * colored statuses. Plain (escape-free) text is padded by its own length so
 * borders align regardless of color. Reasons are shown dimmed and truncated
 * to the terminal width.
 */
function renderBlocks(
  payload: CheckJsonPayload,
  theme: Theme,
  columns: number | undefined,
): string[] {
  const limit = columns && columns > 20 ? columns : DEFAULT_MAX_COLUMNS;
  const venueWidth = Math.max(...payload.venues.map((venue) => venue.length), 4);
  const lines: string[] = [];

  payload.candidates.forEach((candidate, candidateIndex) => {
    const rows = payload.venues.map((venue) => {
      const id = venue.padEnd(venueWidth);
      const result = candidate.results[venue];
      if (!result) {
        return { plain: `${id}  -`, colored: theme.dim(`${id}  -`) };
      }
      const statusText = result.fuzzy ? `${result.status} (fuzzy)` : result.status;
      const statusColored =
        theme.status(result.status, result.status) + (result.fuzzy ? theme.fuzzy(" (fuzzy)") : "");
      let reasonPlain = result.reason ? ` · ${result.reason}` : "";
      let plain = `${id}  ${statusText}${reasonPlain}`;
      if (plain.length > limit && result.reason) {
        // Reserve room for the " · " separator and the trailing "…".
        const room = Math.max(0, limit - (venueWidth + 2 + statusText.length + 4));
        const truncated = result.reason.slice(0, room) + (room < result.reason.length ? "…" : "");
        reasonPlain = ` · ${truncated}`;
        plain = `${id}  ${statusText}${reasonPlain}`;
      }
      const colored = `${id}  ${statusColored}${reasonPlain ? theme.dim(reasonPlain) : ""}`;
      return { plain, colored };
    });

    const title = candidate.input;
    const width = Math.max(
      title.length + 4,
      venueWidth + 12,
      ...rows.map((row) => row.plain.length),
    );
    lines.push(`┌─ ${theme.bold(title)} ${"─".repeat(Math.max(0, width - title.length - 1))}┐`);
    for (const row of rows) {
      lines.push(`│ ${row.colored}${" ".repeat(Math.max(0, width - row.plain.length))} │`);
    }
    lines.push(`└${"─".repeat(width + 2)}┘`);
    if (candidateIndex < payload.candidates.length - 1) lines.push("");
  });

  return lines;
}
