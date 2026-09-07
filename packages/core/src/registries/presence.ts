import type { Clock } from "../ports.js";
import type { RegistryLookupResult } from "../types.js";
import type { RegistryFetch } from "../registry-http.js";

export interface PresenceLookupOptions {
  /** Venue name used in reason strings, e.g. "pypi". */
  venue: string;
  fetch: RegistryFetch;
  clock: Clock;
  /**
   * Validate a 2xx body; return true if it proves presence. Default: any
   * parseable JSON object/array.
   */
  confirmsPresence?(response: Response): Promise<boolean> | boolean;
}

/**
 * Shared honest presence classification for the exact venues. Mirrors npm's
 * semantics: documented 404 -> available, parseable success -> taken, and
 * every rate limit, timeout, transport error, and ambiguous body -> unknown
 * (never presented as available). `checkedAtMs` is set on every branch.
 */
export async function lookupPresence(
  url: string,
  options: PresenceLookupOptions,
): Promise<RegistryLookupResult> {
  const { venue, fetch, clock } = options;
  const confirmsPresence = options.confirmsPresence ?? defaultConfirmsPresence;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      reason: timedOut ? `${venue} request timed out.` : `${venue} request failed.`,
    };
  }

  if (response.status === 404) {
    return { status: "available", checkedAtMs: clock.nowMs() };
  }

  if (response.status === 429) {
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      reason: `${venue} rate limit exceeded.`,
    };
  }

  if (response.status !== 200) {
    return {
      status: "unknown",
      checkedAtMs: clock.nowMs(),
      reason: `${venue} responded with status ${response.status}.`,
    };
  }

  try {
    if (await confirmsPresence(response)) {
      return { status: "taken", checkedAtMs: clock.nowMs() };
    }
  } catch {
    // fall through to ambiguous
  }

  return {
    status: "unknown",
    checkedAtMs: clock.nowMs(),
    reason: `${venue} returned an ambiguous response.`,
  };
}

async function defaultConfirmsPresence(response: Response): Promise<boolean> {
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null;
}
