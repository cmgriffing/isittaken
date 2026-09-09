/**
 * Best-effort in-process sliding-window rate limiter keyed by client identity.
 *
 * This protects each Function isolate against immediate amplification. It is
 * per-isolate by design (Netlify Functions scale horizontally), so it is a
 * first line of defense, not a global quota. Candidate-count and concurrency
 * caps provide the hard bound on upstream work.
 */
export interface RateLimiter {
  /** Returns seconds to wait before retrying, or null when allowed. */
  check(key: string, nowMs: number): number | null;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

interface Bucket {
  timestamps: number[];
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();

  // Bound memory: drop idle buckets once the map gets large.
  const MAX_TRACKED_KEYS = 10_000;

  return {
    check(key: string, nowMs: number): number | null {
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= MAX_TRACKED_KEYS) {
          for (const [existingKey, existing] of buckets) {
            if (existing.timestamps.every((ts) => ts <= nowMs - options.windowMs)) {
              buckets.delete(existingKey);
              if (buckets.size < MAX_TRACKED_KEYS) break;
            }
          }
        }
        bucket = { timestamps: [] };
        buckets.set(key, bucket);
      }

      bucket.timestamps = bucket.timestamps.filter((ts) => ts > nowMs - options.windowMs);
      if (bucket.timestamps.length >= options.limit) {
        const oldest = Math.min(...bucket.timestamps);
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldest + options.windowMs - nowMs) / 1_000),
        );
        return retryAfterSeconds;
      }

      bucket.timestamps.push(nowMs);
      return null;
    },
  };
}
