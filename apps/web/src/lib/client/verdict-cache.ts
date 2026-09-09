/**
 * Browser-side verdict cache keyed by (registry, name), with per-verdict
 * TTLs from the registry descriptors and stale-while-revalidate semantics:
 * fresh entries serve immediately; expired-but-retained entries serve with a
 * "cached" indication while revalidation runs. Storage is bounded with LRU
 * eviction. Mirrors the server cache policy (short `available` freshness,
 * longer `taken` freshness).
 */

export const VERDICT_CACHE_STORAGE_KEY = "iit_verdicts_v1";

/** Default cap on stored entries; verdicts are tiny but quota is finite. */
export const DEFAULT_MAX_ENTRIES = 500;

/** Stale entries stay retained for this multiple of their freshness TTL. */
export const STALE_RETENTION_MULTIPLIER = 7;

export type CachedVerdictStatus = "available" | "taken" | "unknown" | "invalid";

export interface CachedVerdict {
  status: CachedVerdictStatus;
  checkedAtMs: number;
  /** Freshness window that was applied when written. */
  ttlMs: number;
  /** Last-read timestamp for LRU eviction. */
  lastUsedAtMs: number;
}

export type VerdictCacheStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface VerdictCacheOptions {
  ttlFor?: (registryId: string, status: CachedVerdictStatus) => number;
  maxEntries?: number;
  store?: VerdictCacheStore;
}

function defaultStore(): VerdictCacheStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__iit_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export class VerdictCache {
  private entries = new Map<string, CachedVerdict>();
  private store: VerdictCacheStore | null;
  private readonly maxEntries: number;
  private readonly ttlFor: (registryId: string, status: CachedVerdictStatus) => number;

  constructor(options: VerdictCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlFor = options.ttlFor ?? (() => 0);
    this.store = options.store ?? defaultStore();
    this.load();
  }

  private key(registryId: string, name: string): string {
    return `${registryId}:${name}`;
  }

  private load(): void {
    if (!this.store) return;
    try {
      const raw = this.store.getItem(VERDICT_CACHE_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value as Partial<CachedVerdict>;
        if (
          typeof entry.status !== "string" ||
          typeof entry.checkedAtMs !== "number" ||
          typeof entry.ttlMs !== "number" ||
          typeof entry.lastUsedAtMs !== "number"
        ) {
          continue;
        }
        this.entries.set(key, {
          status: entry.status as CachedVerdictStatus,
          checkedAtMs: entry.checkedAtMs,
          ttlMs: entry.ttlMs,
          lastUsedAtMs: entry.lastUsedAtMs,
        });
      }
    } catch {
      // Corrupt storage degrades to an empty cache.
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      const payload: Record<string, CachedVerdict> = {};
      for (const [key, entry] of this.entries) payload[key] = entry;
      this.store.setItem(VERDICT_CACHE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota errors are non-fatal; the in-memory copy stays usable.
    }
  }

  /** Evict least-recently-used entries until the cap is respected. */
  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastUsedAtMs - b[1].lastUsedAtMs,
    );
    while (sorted.length > 0 && this.entries.size > this.maxEntries) {
      const [key] = sorted.shift() as [string, CachedVerdict];
      this.entries.delete(key);
    }
  }

  /**
   * Read a cached verdict. Returns `fresh` within the TTL, `stale` after
   * (retained for the retention window), or null when absent/evicted.
   */
  read(
    registryId: string,
    name: string,
    nowMs: number,
  ): { status: "fresh" | "stale"; verdict: CachedVerdict } | null {
    const key = this.key(registryId, name);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.ttlMs <= 0) return null; // never-fresh entry
    const expiresAtMs = entry.checkedAtMs + entry.ttlMs;
    const retentionCutoff = entry.checkedAtMs + entry.ttlMs * STALE_RETENTION_MULTIPLIER;
    if (nowMs >= retentionCutoff) {
      this.entries.delete(key);
      this.persist();
      return null;
    }
    // Touch for LRU purposes.
    entry.lastUsedAtMs = nowMs;
    this.persist();
    return { status: nowMs < expiresAtMs ? "fresh" : "stale", verdict: entry };
  }

  write(
    registryId: string,
    name: string,
    status: CachedVerdictStatus,
    checkedAtMs: number,
    nowMs: number,
  ): void {
    const ttlMs = Math.max(0, this.ttlFor(registryId, status));
    this.entries.set(this.key(registryId, name), {
      status,
      checkedAtMs,
      ttlMs,
      lastUsedAtMs: nowMs,
    });
    this.evict();
    this.persist();
  }

  get size(): number {
    return this.entries.size;
  }
}
