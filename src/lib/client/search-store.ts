import type { ComposedCandidate, RegistryId, SearchResponse } from "../../domain/types";
import { REGISTRY_LINEUP, registryById } from "../../domain/registries";
import type { RegistryDescriptor } from "../../domain/registries";
import {
  createAvailabilityService,
  type AvailabilityService,
  type CheckCandidatesOptions,
  type VerdictCell,
} from "./availability";
import {
  mergeCandidates,
  searchCreative,
  searchOrdinary,
  type CreativeClientResult,
  type OrdinaryResult,
} from "./api";

/**
 * Module-level shared search store: one instance per page holding the
 * candidates, the availability service (shared bounded queue + verdict
 * cache), the registry selection (live + saved pair), and the verdict cell
 * map. The island subscribes and renders; WebMCP tools call the same
 * actions, so agent batches drive the visible UI with zero duplicated
 * fan-out logic. Hand-rolled pub/sub — no new dependencies.
 */

export const REGISTRY_SELECTION_STORAGE_KEY = "iit_registry_selection";

/** Ordinary-search lifecycle (mirrors the island's phases). */
export type OrdinaryPhase = "idle" | "loading" | "error" | "done";

export interface BatchProgress {
  done: number;
  total: number;
}

export interface SearchState {
  /** Ordinary discovery response, when one has completed. */
  ordinary: SearchResponse | null;
  phase: OrdinaryPhase;
  message: string | null;
  retryAfterSeconds: number | null;
  /** Creative-generation state; tools never touch this. */
  creative: CreativeClientResult | null;
  creativeLoading: boolean;
  /** Merged candidate list (ordinary + creative), deduped by name. */
  candidates: ComposedCandidate[];
  /** Live selection (what the fan-out checks), in lineup order. */
  selectedIds: RegistryId[];
  /** Saved selection (localStorage mirror; the user's durable preference). */
  savedIds: RegistryId[];
  /** True after an agent replaced the live selection (never persisted). */
  agentTouched: boolean;
  /** Ids whose live membership differs from the saved one. */
  agentChangedIds: RegistryId[];
  /** Live selection differs from saved → restore affordance shows. */
  canRestore: boolean;
  /** True while an agent batch driven through runBatch is in flight. */
  batchInFlight: boolean;
  /** Live done/total for any in-flight fan-out; null when settled. */
  progress: BatchProgress | null;
  /** Verdict cells keyed by `candidateName|registryId`. */
  cells: Map<string, VerdictCell>;
}

function defaultSelection(): RegistryId[] {
  return REGISTRY_LINEUP.map((descriptor) => descriptor.id);
}

function loadSavedSelection(): RegistryId[] {
  try {
    const raw = localStorage.getItem(REGISTRY_SELECTION_STORAGE_KEY);
    if (!raw) return defaultSelection();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultSelection();
    // Only supported ids, lineup order preserved.
    return REGISTRY_LINEUP.filter((descriptor) => parsed.includes(descriptor.id)).map(
      (descriptor) => descriptor.id,
    );
  } catch {
    return defaultSelection();
  }
}

function trySaveSelection(ids: RegistryId[]): void {
  try {
    localStorage.setItem(REGISTRY_SELECTION_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailability never breaks the search itself.
  }
}

export function cellKey(candidateName: string, registryId: RegistryId): string {
  return `${candidateName}|${registryId}`;
}

export type SearchListener = () => void;

export interface BatchInput {
  seed: string;
  injectedSynonyms?: readonly string[];
  injectedCreatives?: readonly string[];
  /** Exact-replace of the live selection when provided. */
  registries?: readonly RegistryId[];
  /** Abort: stops scheduling new checks; in-flight work still settles. */
  signal?: AbortSignal;
}

export type BatchResult =
  | {
      ok: true;
      candidates: ComposedCandidate[];
      verdicts: VerdictCell[];
      /** Unknown registry ids passed in `registries`, when any. */
      unknownRegistries: RegistryId[];
      /** Effective registry list the batch checked. */
      selectionUsed: RegistryId[];
    }
  | {
      ok: false;
      reason: "empty_seed" | "search_failed" | "rate_limited" | "invalid" | "aborted";
      message?: string;
      retryAfterSeconds?: number | null;
    };

export interface SearchStoreOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface SearchStore {
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: SearchListener): () => void;
  getState(): SearchState;
  /** Toggle one registry as the user (persists to saved). */
  toggleRegistry(id: RegistryId, enabled: boolean): void;
  /** Agent-driven exact-replace of the live selection (never persists). */
  setAgentSelection(ids: readonly RegistryId[]): { unknownRegistries: RegistryId[] };
  /** One-click revert of the live selection to the saved selection. */
  restoreSavedSelection(): void;
  /** True while an agent batch driven through runBatch is in flight. */
  hasBatchInFlight(): boolean;
  /** Current batch progress, when one is in flight. */
  getProgress(): BatchProgress | null;
  /** Abort the in-flight agent batch, if any (user toggle mid-batch wins). */
  abortBatch(): void;
  /** Ordinary discovery + fan-out (the user's search form action). */
  runSearch(seed: string): Promise<void>;
  /** Creative generation (island-only; session + quota). */
  runCreative(regenerate: boolean): Promise<void>;
  /** Seed as entered (untrimmed) for the input binding. */
  setSeed(seed: string): void;
  getSeed(): string;
  /** Discovery-only path used by the search_names tool (same limits). */
  fetchDiscovery(
    seed: string,
    injected?: { synonyms?: readonly string[]; creatives?: readonly string[] },
  ): Promise<OrdinaryResult>;
  /** Batch: discovery + selection replace + fan-out + verdict resolution. */
  runBatch(input: BatchInput): Promise<BatchResult>;
  /** Headless single (name, registry) verdict through the shared service. */
  checkOne(name: string, registryId: RegistryId): Promise<VerdictCell>;
}

export function createSearchStore(options: SearchStoreOptions = {}): SearchStore {
  const now = options.now ?? (() => Date.now());
  // Resolve the global fetch at call time (not store-creation time) unless
  // an explicit implementation was provided — keeps tests' global stubs
  // effective and matches api.ts's dynamic resolution.
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let seed = "";
  let ordinary: SearchResponse | null = null;
  let phase: OrdinaryPhase = "idle";
  let message: string | null = null;
  let retryAfterSeconds: number | null = null;
  let creative: CreativeClientResult | null = null;
  let creativeLoading = false;
  let merged: ComposedCandidate[] = [];
  let selectedIds = loadSavedSelection();
  let savedIds = [...selectedIds];
  let agentTouched = false;
  let cells = new Map<string, VerdictCell>();
  let service: AvailabilityService | null = null;
  let batchInFlight = false;
  let batchAbort: AbortController | null = null;
  let progress: BatchProgress | null = null;
  // Per-run verdict collector: the service's single onResult pushes into
  // both the paint map and whatever run is currently collecting.
  let collector: VerdictCell[] | null = null;

  const listeners = new Set<SearchListener>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function selectedDescriptors(): RegistryDescriptor[] {
    return selectedIds.map((id) => registryById(id)).filter((d): d is RegistryDescriptor => !!d);
  }

  function ensureService(): AvailabilityService {
    if (!service) {
      // The service binds to the full lineup for cache-TTL purposes; the
      // actually-checked registries are passed per call via `registries`.
      service = createAvailabilityService({
        registries: REGISTRY_LINEUP,
        onResult: (cell) => {
          cells = new Map(cells);
          cells.set(cellKey(cell.candidateName, cell.registry), cell);
          collector?.push(cell);
          emit();
        },
        now,
        fetchImpl,
      });
    }
    return service;
  }

  /**
   * Fan out availability checks for `candidates` under the current (or
   * explicit) selection, driving `progress` as verdicts land. Resolves when
   * every check settles (or is aborted).
   */
  function fanOut(input: {
    candidates: readonly { name: string }[];
    registries?: readonly RegistryDescriptor[];
    signal?: AbortSignal;
  }): Promise<void> {
    const targets = input.registries ?? selectedDescriptors();
    if (targets.length === 0 || input.candidates.length === 0) return Promise.resolve();
    const active = ensureService();
    progress = { done: 0, total: 0 };
    emit();
    const runOptions: CheckCandidatesOptions = {
      registries: targets,
      onProgress: (next) => {
        progress = next;
        emit();
      },
    };
    if (input.signal) runOptions.signal = input.signal;
    return active.checkCandidates(input.candidates, runOptions).finally(() => {
      progress = null;
      emit();
    });
  }

  function snapshot(): SearchState {
    const agentChangedIds = REGISTRY_LINEUP.map((d) => d.id).filter(
      (id) => selectedIds.includes(id) !== savedIds.includes(id),
    );
    return {
      ordinary,
      phase,
      message,
      retryAfterSeconds,
      creative,
      creativeLoading,
      candidates: merged,
      selectedIds: [...selectedIds],
      savedIds: [...savedIds],
      agentTouched,
      agentChangedIds,
      canRestore:
        selectedIds.length !== savedIds.length || selectedIds.some((id) => !savedIds.includes(id)),
      batchInFlight,
      progress,
      cells,
    };
  }

  function setState(mutate: () => void): void {
    mutate();
    emit();
  }

  function userSelectionChanged(next: RegistryId[]): void {
    setState(() => {
      selectedIds = [...next];
      savedIds = [...next];
      agentTouched = false;
    });
    trySaveSelection(next);
    // A selection change always wins over in-flight agent batch scheduling.
    batchAbort?.abort();
    batchAbort = null;
  }

  function handleOrdinaryFailure(result: OrdinaryResult): void {
    setState(() => {
      phase = "error";
      if (result.status === "invalid") message = result.message;
      else if (result.status === "rate-limited") {
        message = result.retryAfterSeconds
          ? `Too many searches — retry in ${result.retryAfterSeconds}s.`
          : "Too many searches — wait a moment and retry.";
        retryAfterSeconds = result.retryAfterSeconds;
      } else message = "Search failed. Check your connection and retry.";
    });
  }

  const store: SearchStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState() {
      return snapshot();
    },

    toggleRegistry(id, enabled) {
      const next = enabled
        ? REGISTRY_LINEUP.filter((d) => selectedIds.includes(d.id) || d.id === id).map((d) => d.id)
        : selectedIds.filter((existing) => existing !== id);
      userSelectionChanged(next);
      // Re-check visible candidates under the new selection.
      if (phase === "done" && merged.length > 0 && selectedIds.length > 0) {
        void fanOut({ candidates: merged.map((c) => ({ name: c.name })) });
      }
    },

    setAgentSelection(ids) {
      const wanted = [...new Set(ids)];
      const unknownRegistries = wanted.filter((id) => !registryById(id));
      const known = wanted.filter((id) => !!registryById(id));
      setState(() => {
        selectedIds = REGISTRY_LINEUP.filter((d) => known.includes(d.id)).map((d) => d.id);
        agentTouched = true;
      });
      return { unknownRegistries };
    },

    restoreSavedSelection() {
      setState(() => {
        selectedIds = [...savedIds];
        agentTouched = false;
      });
      batchAbort?.abort();
      batchAbort = null;
      // Re-check visible candidates under the restored selection.
      if (phase === "done" && merged.length > 0 && selectedIds.length > 0) {
        void fanOut({ candidates: merged.map((c) => ({ name: c.name })) });
      }
    },

    hasBatchInFlight() {
      return batchInFlight;
    },

    getProgress() {
      return progress;
    },

    abortBatch() {
      batchAbort?.abort();
      batchAbort = null;
    },

    async runSearch(nextSeed) {
      const trimmed = nextSeed.trim();
      setState(() => {
        seed = nextSeed;
        message = null;
        retryAfterSeconds = null;
        phase = trimmed ? "loading" : "error";
        if (!trimmed) message = "Enter a seed word first.";
      });
      if (!trimmed) return;

      const result = await searchOrdinary(trimmed);
      if (result.status === "ok") {
        ordinary = result.data;
        merged = mergeCandidates([
          ordinary.candidates,
          creative?.status === "ok" ? creative.data.candidates : undefined,
        ]);
        setState(() => {
          phase = "done";
          cells = new Map();
        });
        await fanOut({ candidates: merged.map((c) => ({ name: c.name })) });
        return;
      }
      handleOrdinaryFailure(result);
    },

    async runCreative(regenerate) {
      if (!seed.trim()) return;
      setState(() => {
        creativeLoading = true;
      });
      const result = await searchCreative(seed.trim(), regenerate);
      setState(() => {
        creative = result;
        creativeLoading = false;
      });
      if (result.status === "ok") {
        merged = mergeCandidates([ordinary?.candidates, result.data.candidates]);
        setState(() => {
          cells = new Map();
        });
        await fanOut({ candidates: merged.map((c) => ({ name: c.name })) });
        return;
      }
    },

    setSeed(next) {
      setState(() => {
        seed = next;
      });
    },

    getSeed() {
      return seed;
    },

    async fetchDiscovery(nextSeed, injected) {
      return searchOrdinary(nextSeed, {
        synonyms: [...(injected?.synonyms ?? [])],
        creatives: [...(injected?.creatives ?? [])],
      });
    },

    async runBatch(input) {
      const trimmed = input.seed.trim();
      if (!trimmed) return { ok: false, reason: "empty_seed" };

      // Exact-replace selection when provided (caller validated non-empty
      // of known ids; unknown ids are reported, not applied).
      let unknownRegistries: RegistryId[] = [];
      if (input.registries) {
        const agentResult = store.setAgentSelection(input.registries);
        unknownRegistries = agentResult.unknownRegistries;
      }

      const selectionUsed = [...selectedIds];
      if (selectionUsed.length === 0) {
        // All-invalid request: discovery still runs (quota-free with only
        // injected candidates) but there is nothing to fan out against.
        return {
          ok: true,
          candidates: [],
          verdicts: [],
          unknownRegistries,
          selectionUsed,
        };
      }

      const discovery = await searchOrdinary(
        trimmed,
        input.injectedSynonyms || input.injectedCreatives
          ? {
              synonyms: [...(input.injectedSynonyms ?? [])],
              creatives: [...(input.injectedCreatives ?? [])],
            }
          : undefined,
      );
      if (discovery.status !== "ok") {
        handleOrdinaryFailure(discovery);
        if (discovery.status === "rate-limited") {
          return {
            ok: false,
            reason: "rate_limited",
            retryAfterSeconds: discovery.retryAfterSeconds,
          };
        }
        return {
          ok: false,
          reason: discovery.status === "invalid" ? "invalid" : "search_failed",
          message: discovery.status === "invalid" ? discovery.message : undefined,
        };
      }

      ordinary = discovery.data;
      merged = mergeCandidates([
        ordinary.candidates,
        creative?.status === "ok" ? creative.data.candidates : undefined,
      ]);
      setState(() => {
        phase = "done";
        message = null;
        retryAfterSeconds = null;
        cells = new Map();
      });

      batchInFlight = true;
      batchAbort = new AbortController();
      const signal = input.signal
        ? joinSignals(batchAbort.signal, input.signal)
        : batchAbort.signal;
      collector = [];
      emit();
      try {
        await fanOut({
          candidates: merged.map((c) => ({ name: c.name })),
          signal,
        });
      } finally {
        batchInFlight = false;
        batchAbort = null;
        collector = null;
      }

      if (signal.aborted) {
        return { ok: false, reason: "aborted" };
      }

      const byKey = new Map<string, VerdictCell>();
      for (const cell of cells.values()) {
        byKey.set(cellKey(cell.candidateName, cell.registry), cell);
      }
      setState(() => {
        phase = "done";
      });
      return {
        ok: true,
        candidates: merged,
        verdicts: [...byKey.values()],
        unknownRegistries,
        selectionUsed,
      };
    },

    async checkOne(name, registryId) {
      const descriptor = registryById(registryId);
      if (!descriptor) throw new Error(`Unsupported registry: ${registryId}`);
      const found: VerdictCell[] = [];
      const active = ensureService();
      const previousCollector = collector;
      collector = found;
      try {
        await active.checkCandidates([{ name }], { registries: [descriptor] });
      } finally {
        collector = previousCollector;
      }
      const cell = found.at(-1);
      if (!cell) {
        return {
          registry: registryId,
          candidateName: name,
          checkedName: name,
          status: "unknown",
          checkedAtMs: now(),
          reason: "Check did not produce a verdict.",
        };
      }
      return cell;
    },
  };

  return store;
}

function joinSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/** The page-wide singleton store (created lazily, on first request). */
let singleton: SearchStore | null = null;

export function getSearchStore(options: SearchStoreOptions = {}): SearchStore {
  if (!singleton) singleton = createSearchStore(options);
  return singleton;
}

/** Drop the singleton so the next `getSearchStore` creates a fresh store. */
export function resetSearchStoreForTests(): void {
  singleton = null;
}
