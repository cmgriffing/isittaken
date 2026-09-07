import type { Clock } from "@isittaken/core";

/**
 * Monotonic clock: `Date.now()` with a +1ms guard so repeated reads within
 * the same millisecond never collide. Same pattern as the web app's
 * composition root.
 */
export function createClock(): Clock {
  let monotonic = 0;
  return {
    nowMs: () => {
      const t = Date.now();
      return t > monotonic ? (monotonic = t) : (monotonic += 1);
    },
  };
}
