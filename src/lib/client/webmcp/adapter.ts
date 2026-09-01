import type { RegistryId, RegistryStatus } from "../../../domain/types";
import { REGISTRY_LINEUP } from "../../../domain/registries";
import { type SearchLimits } from "../../../domain/validate-search-request";
import { validateSearchRequest } from "../../../domain/validate-search-request";
import type { VerdictCell } from "../availability";
import { getSearchStore, type SearchStore } from "../search-store";

/**
 * WebMCP browser-tool adapter — the only module that touches the draft API
 * (`document.modelContext`, W3C CG report, 26 Aug 2026; ambient types in
 * `types.d.ts`). Registers four tools wired to the shared search store: the
 * same queue, cache, and state the island renders. Tool errors are
 * fulfilled structured results shaped `{ error: { code, message } }`,
 * never rejections.
 */

/** Structured, agent-legible tool error (fulfilled, not thrown). */
export interface ToolError {
  error: {
    code: string;
    message?: string;
  };
  detail?: string;
  progress?: { done: number; total: number };
  [key: string]: unknown;
}

export interface RegistrySummary {
  id: RegistryId;
  label: string;
  language: string;
  venue: "server" | "browser";
  linkBase: string;
}

/** Public surface for tests: the tool definitions before registration. */
export interface WebMcpAdapter {
  tools: readonly ManagedTool[];
  register(): void;
}

interface ManagedTool {
  name: string;
  definition: ModelContextToolDefinition;
}

const BATCH_BUSY_DETAIL =
  "Another batch is already running on this page. Wait for it to finish, or abort your pending batch_check_availability call and retry.";

/**
 * Client-side mirror of the server discovery limits (public config
 * defaults: seed 64, injected 25/25, candidate 214, total 120). Tool
 * validation matches the HTTP surface; the server re-validates.
 */
const SEARCH_LIMITS: SearchLimits = {
  maxSeedLength: 64,
  maxInjectedSynonyms: 25,
  maxInjectedCreatives: 25,
  maxCandidateLength: 214,
  maxTotalCandidates: 120,
};

/** Exported for tests that assert the schema mirrors these limits. */
export const TOOL_SEARCH_LIMITS: Readonly<SearchLimits> = SEARCH_LIMITS;

const BATCH_DESCRIPTION =
  "Check package-name availability for a batch of candidates across selected registries, driving the visible results grid live. " +
  "Runs ONE batch at a time per page: while a batch is in flight, a concurrent call is refused immediately with batch_in_progress (wait or abort your pending call). " +
  "A batch may take several seconds to complete (network checks across up to 8 registries per candidate). " +
  "Input: seed (required), optional injectedSynonyms / injectedCreatives (your own alternative names; they consume no AI quota), and optional registries (array of registry ids that will exactly replace the selection the human sees on the page — omit to use the current selection). " +
  "Resolves with per-candidate, per-registry verdicts plus selectionUsed when the fan-out completes.";

/**
 * Build the adapter. ` getModelContext` is injectable for tests; default
 * resolves the draft API off `document`.
 */
export interface CreateWebMcpAdapterOptions {
  store?: SearchStore;
  getModelContext?: () => unknown | undefined;
  onProgressEvent?: (detail: { tool: string; done: number; total: number }) => void;
}

const TOOL_PROGRESS_EVENT = "isittaken:toolprogress";

export function createWebMcpAdapter(options: CreateWebMcpAdapterOptions = {}): WebMcpAdapter {
  const store = options.store ?? getSearchStore();
  const getModelContext = options.getModelContext ?? ((): unknown => document.modelContext);
  const onProgressEvent =
    options.onProgressEvent ??
    ((detail: { tool: string; done: number; total: number }) => {
      const target = document.modelContext as unknown as EventTarget | undefined;
      target?.dispatchEvent?.(new CustomEvent(TOOL_PROGRESS_EVENT, { detail }));
    });

  const inputSchema = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });

  const seedSchema = {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "Seed word or short phrase: unicode letters/digits, spaces, apostrophes, hyphens, dots.",
  };

  const injectedLists = {
    injectedSynonyms: {
      type: "array",
      items: { type: "string" },
      maxItems: 25,
      description: "Caller-supplied synonym-style candidates (no AI quota used).",
    },
    injectedCreatives: {
      type: "array",
      items: { type: "string" },
      maxItems: 25,
      description: "Caller-supplied creative alternatives (no AI quota used).",
    },
  };

  function lineups(): RegistrySummary[] {
    return REGISTRY_LINEUP.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      language: descriptor.language,
      venue: descriptor.venue,
      linkBase: descriptor.checkOrigin,
    }));
  }

  function summarizeCell(cell: VerdictCell): {
    candidate: string;
    registry: RegistryId;
    status: RegistryStatus;
    name: string;
    checkedAtMs?: number;
    reason?: string;
  } {
    return {
      candidate: cell.candidateName,
      registry: cell.registry,
      status: cell.status,
      name: cell.checkedName,
      ...(cell.checkedAtMs !== undefined ? { checkedAtMs: cell.checkedAtMs } : {}),
      ...(cell.reason ? { reason: cell.reason } : {}),
    };
  }

  /** Translate validation failures into structured tool errors. */
  function validationError(error: unknown): ToolError {
    const code = (error as { code?: string })?.code ?? "invalid_seed";
    const message = error instanceof Error ? error.message : String(error);
    return { error: { code, message } };
  }

  // --- Tool implementations -------------------------------------------------

  function listRegistries(): { registries: RegistrySummary[] } {
    return { registries: lineups() };
  }

  interface SearchNamesOk {
    candidates: { name: string; provenance: string[] }[];
    generatedAtMs: number;
    seed: string;
  }

  async function searchNames(input: Record<string, unknown>): Promise<unknown> {
    const seed = input["seed"];
    if (typeof seed !== "string") {
      return { error: { code: "invalid_seed", message: "seed must be a string." } };
    }
    const synonyms = input["injectedSynonyms"];
    const creatives = input["injectedCreatives"];
    if (synonyms !== undefined && !Array.isArray(synonyms)) {
      return { error: { code: "invalid_injected", message: "injectedSynonyms must be an array." } };
    }
    if (creatives !== undefined && !Array.isArray(creatives)) {
      return {
        error: { code: "invalid_injected", message: "injectedCreatives must be an array." },
      };
    }
    try {
      // Validate via the domain path first: identical codes and messages as
      // the HTTP surface, thrown before any network call.
      validateSearchRequest(
        {
          seed,
          injectedSynonyms: (synonyms as unknown[] | undefined)?.map(String),
          injectedCreatives: (creatives as unknown[] | undefined)?.map(String),
        },
        SEARCH_LIMITS,
      );
      const result = await store.fetchDiscovery(seed, {
        synonyms: (synonyms as unknown[] | undefined)?.map(String),
        creatives: (creatives as unknown[] | undefined)?.map(String),
      });
      if (result.status !== "ok") {
        return toStructuredSearchError(result);
      }
      const ok: SearchNamesOk = {
        seed: result.data.seed,
        generatedAtMs: result.data.generatedAtMs,
        candidates: result.data.candidates.map((candidate) => ({
          name: candidate.name,
          provenance: [...candidate.provenance],
        })),
      };
      return ok;
    } catch (error) {
      return validationError(error);
    }
  }

  /**
   * Map a failed discovery response to a structured tool error. The domain
   * validation codes were already applied above; failures here are transport
   * or rate-limit conditions.
   */
  function toStructuredSearchError(result: {
    status: string;
    message?: string;
    retryAfterSeconds?: number | null;
  }): ToolError {
    if (result.status === "rate-limited") {
      return {
        error: { code: "rate_limited", message: "Too many search requests." },
        ...(result.retryAfterSeconds != null
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {}),
      };
    }
    if (result.status === "invalid") {
      return { error: { code: "invalid_request", message: result.message } };
    }
    return { error: { code: "search_failed", message: "Search request failed." } };
  }

  async function checkAvailability(input: Record<string, unknown>): Promise<unknown> {
    const word = input["word"];
    const registry = input["registry"];
    if (typeof word !== "string" || typeof registry !== "string") {
      return {
        error: { code: "invalid_request", message: "word and registry are required strings." },
      };
    }
    const known = REGISTRY_LINEUP.find((descriptor) => descriptor.id === registry);
    if (!known) {
      return {
        error: { code: "unknown_registry", message: `Unsupported registry: ${registry}.` },
        detail: `Supported ids: ${lineups()
          .map((r) => r.id)
          .join(", ")}.`,
      };
    }
    try {
      const cell = await store.checkOne(word, registry);
      return summarizeCell(cell);
    } catch (error) {
      return validationError(error);
    }
  }

  // --- Batch with single-flight gate ----------------------------------------

  let busy = false;
  let activeAbort: AbortController | null = null;

  function currentProgress(): { done: number; total: number } | undefined {
    const progress = store.getProgress();
    return progress ? { done: progress.done, total: progress.total } : undefined;
  }

  function clearGate(): void {
    busy = false;
    activeAbort = null;
  }

  function batchCheckAvailability(
    input: Record<string, unknown>,
    executeOptions: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (busy) {
      return Promise.resolve({
        error: {
          code: "batch_in_progress",
          message: "A batch is already running; one batch at a time per page.",
        },
        progress: currentProgress(),
        detail: BATCH_BUSY_DETAIL,
      } satisfies ToolError);
    }

    const seed = input["seed"];
    if (typeof seed !== "string") {
      return Promise.resolve({
        error: { code: "invalid_seed", message: "seed must be a string." },
      });
    }
    const synonyms = input["injectedSynonyms"];
    const creatives = input["injectedCreatives"];
    if (synonyms !== undefined && !Array.isArray(synonyms)) {
      return Promise.resolve({
        error: { code: "invalid_injected", message: "injectedSynonyms must be an array." },
      });
    }
    if (creatives !== undefined && !Array.isArray(creatives)) {
      return Promise.resolve({
        error: { code: "invalid_injected", message: "injectedCreatives must be an array." },
      });
    }
    // Domain validation before any network call: identical codes to HTTP.
    try {
      validateSearchRequest(
        {
          seed,
          injectedSynonyms: (synonyms as unknown[] | undefined)?.map(String),
          injectedCreatives: (creatives as unknown[] | undefined)?.map(String),
        },
        SEARCH_LIMITS,
      );
    } catch (error) {
      return Promise.resolve(validationError(error));
    }
    let registries: string[] | undefined;
    const rawRegistries = input["registries"];
    if (rawRegistries !== undefined) {
      if (!Array.isArray(rawRegistries)) {
        return Promise.resolve({
          error: { code: "invalid_request", message: "registries must be an array of ids." },
        });
      }
      registries = rawRegistries.map(String);
      if (registries.length === 0) {
        return Promise.resolve({
          error: {
            code: "invalid_request",
            message:
              "registries must name at least one registry; omit the field to use the current selection.",
          },
          detail: `Supported ids: ${lineups()
            .map((r) => r.id)
            .join(", ")}.`,
        });
      }
    }

    busy = true;
    activeAbort = new AbortController();
    if (executeOptions?.signal) {
      const signal = executeOptions?.signal;
      // The caller's signal wins; forward it into the batch signal.
      const forward = () => activeAbort?.abort();
      if (signal.aborted) activeAbort.abort();
      else signal.addEventListener("abort", forward, { once: true });
      forwardCleanup = () => signal.removeEventListener("abort", forward);
    }

    const batch = store
      .runBatch({
        seed,
        injectedSynonyms: (synonyms as unknown[] | undefined)?.map(String),
        injectedCreatives: (creatives as unknown[] | undefined)?.map(String),
        registries,
        signal: activeAbort.signal,
      })
      .then((result): unknown => {
        // Abort: runBatch fulfills (cells may be partial); report the
        // structured aborted outcome so the agent gets a legible result.
        if (activeAbort?.signal.aborted || executeOptions?.signal?.aborted) {
          return { error: { code: "batch_aborted" } } satisfies ToolError;
        }
        if (!result.ok) {
          return toBatchFailure(result);
        }
        return {
          candidates: result.candidates.map((candidate) => ({
            name: candidate.name,
            provenance: [...candidate.provenance],
          })),
          verdicts: result.verdicts.map(summarizeCell),
          selectionUsed: [...result.selectionUsed],
          ...(result.unknownRegistries.length > 0
            ? { unknownRegistries: [...result.unknownRegistries] }
            : {}),
        };
      })
      .catch((error: unknown): ToolError => {
        if (activeAbort?.signal.aborted || executeOptions?.signal?.aborted) {
          return { error: { code: "batch_aborted" } };
        }
        return {
          error: {
            code: "batch_failed",
            message: error instanceof Error ? error.message : "Batch failed unexpectedly.",
          },
        };
      })
      .finally(() => {
        clearGate();
        forwardCleanup?.();
        forwardCleanup = null;
      });

    return batch;
  }

  function toBatchFailure(result: {
    reason: string;
    message?: string;
    retryAfterSeconds?: number | null;
  }): ToolError {
    if (result.reason === "empty_seed") {
      return { error: { code: "invalid_seed", message: "Seed term must be non-empty." } };
    }
    if (result.reason === "aborted") {
      return { error: { code: "batch_aborted" } };
    }
    if (result.reason === "rate_limited") {
      return {
        error: { code: "rate_limited", message: "Too many search requests." },
        ...(result.retryAfterSeconds != null
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {}),
      };
    }
    if (result.reason === "invalid") {
      return { error: { code: "invalid_request", message: result.message } };
    }
    return { error: { code: "search_failed", message: "Search request failed." } };
  }

  let forwardCleanup: (() => void) | null = null;

  // --- Tool definitions -----------------------------------------------------

  const annotations = (extra: ModelContextToolAnnotations = {}): ModelContextToolAnnotations => ({
    readOnlyHint: true,
    ...extra,
  });

  const tools: ManagedTool[] = [
    {
      name: "list_registries",
      definition: {
        name: "list_registries",
        title: "List supported package registries",
        description:
          "List the package registries this site can check (ids, labels, languages, where checks run, and package-link bases). No network requests.",
        inputSchema: inputSchema({}, []),
        execute: () => listRegistries(),
        annotations: annotations(),
      },
    },
    {
      name: "search_names",
      definition: {
        name: "search_names",
        title: "Discover package-name candidates",
        description:
          "Discover package-name candidates for a seed word (synonyms via Wordnik). Supply your own alternatives with injectedSynonyms / injectedCreatives — they are validated with the same limits as the HTTP API and consume zero AI quota. Does NOT check availability; use check_availability or batch_check_availability for verdicts.",
        inputSchema: inputSchema({ seed: seedSchema, ...injectedLists }, ["seed"]),
        execute: (input) => searchNames(input),
        annotations: annotations({ untrustedContentHint: true }),
      },
    },
    {
      name: "check_availability",
      definition: {
        name: "check_availability",
        title: "Check one name on one registry",
        description:
          "Check a single name against a single package registry. Returns one verdict (available | taken | invalid | unknown) with the checked (normalized) name and timestamp. Shares the page's verdict cache and check queue.",
        inputSchema: inputSchema(
          {
            word: { type: "string", minLength: 1, maxLength: 214, description: "Name to check." },
            registry: {
              type: "string",
              description: "Registry id from list_registries.",
            },
          },
          ["word", "registry"],
        ),
        execute: (input) => checkAvailability(input),
        annotations: annotations(),
      },
    },
    {
      name: "batch_check_availability",
      definition: {
        name: "batch_check_availability",
        title: "Batch-check availability and drive the page",
        description: BATCH_DESCRIPTION,
        inputSchema: inputSchema(
          {
            seed: seedSchema,
            ...injectedLists,
            registries: {
              type: "array",
              items: { type: "string" },
              maxItems: 8,
              description:
                "Registry ids that will exactly replace the visible on-page selection (unknown ids are refused and reported). Omit to use the current selection.",
            },
          },
          ["seed"],
        ),
        execute: (input, executeOptions) =>
          batchCheckAvailability(input, (executeOptions ?? {}) as { signal?: AbortSignal }),
        annotations: annotations({ untrustedContentHint: true }),
      },
    },
  ];

  return {
    tools,
    register() {
      const context = getModelContext();
      if (!context || typeof (context as ModelContextApi).registerTool !== "function") {
        return;
      }
      const api = context as ModelContextApi;
      // Progress re-dispatch: bridge the store's progress to page-adjacent
      // tooling via the namespaced extension event. Zero-total ticks are
      // pre-normalization warmup; only real counts are worth dispatching.
      store.subscribe(() => {
        const progress = currentProgress();
        if (progress && busy && progress.total > 0) {
          try {
            onProgressEvent({ tool: "batch_check_availability", ...progress });
          } catch {
            // Event dispatch must never break a running batch.
          }
        }
      });
      for (const tool of tools) {
        try {
          const maybePromise = (api as ModelContextApi).registerTool(tool.definition);
          if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
            (maybePromise as Promise<unknown>).catch((error: unknown) => {
              console.warn(
                `[webmcp] registerTool(${tool.name}) rejected:`,
                error instanceof Error ? error.message : error,
              );
            });
          }
        } catch (error) {
          console.warn(
            `[webmcp] registerTool(${tool.name}) failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    },
  };
}

interface ModelContextApi {
  registerTool(tool: ModelContextToolDefinition): unknown;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
  dispatchEvent?: (event: Event) => boolean;
}

/**
 * Feature-detected registration entry point for the home page. No-ops
 * everywhere the draft API is absent.
 */
export function registerWebMcpTools(): void {
  if (typeof document === "undefined" || !("modelContext" in document)) return;
  try {
    const adapter = createWebMcpAdapter();
    adapter.register();
  } catch (error) {
    console.warn(
      "[webmcp] tool registration failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
