# Transport-Neutral Contracts (WebMCP adapter shipped)

The application's core operations are callable without HTTP. Today the
Netlify Functions translate JSON requests into the models below; the
browser WebMCP adapter (`src/lib/client/webmcp/`) maps tool arguments to the
_same_ models and maps tool results back from them, without duplicating
validation, provenance, deduplication, or availability rules.

There are two core operations, matching the split HTTP surface — plus the
client-side fan-out that turns discovery into verdicts:

1. **Candidate discovery** — seed (+ optional injected candidates) → names
   with provenance. No registry contact.
2. **Single-registry availability check** — one name, one registry → one
   verdict.
3. **Batch availability fan-out** — candidates × selected registries, run
   by the client (server venues via `/api/check`, browser venues against
   their CORS endpoints) and painted live in the results grid.

## Shipped WebMCP tools

The home page registers four tools via `document.modelContext.registerTool`
when the draft browser API (W3C WebMCP CG report, 26 Aug 2026) is present.
Browsers without it are unaffected; registration failures are logged and
ignored. The adapter module is the only file touching the draft API
(enforced by `tests/contract/webmcp-capabilities.test.ts`).

| Tool                       | Input                                                            | Result                                                         | Annotations                            |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `list_registries`          | —                                                                | `{ registries: [{ id, label, language, venue, linkBase }] }`   | `readOnlyHint`                         |
| `search_names`             | `seed`, `injectedSynonyms?`, `injectedCreatives?`                | `{ seed, generatedAtMs, candidates: [{ name, provenance }] }`  | `readOnlyHint`, `untrustedContentHint` |
| `check_availability`       | `word`, `registry`                                               | `{ candidate, registry, status, name, checkedAtMs?, reason? }` | `readOnlyHint`                         |
| `batch_check_availability` | `seed`, `injectedSynonyms?`, `injectedCreatives?`, `registries?` | `{ candidates, verdicts: [...], selectionUsed }`               | `readOnlyHint`, `untrustedContentHint` |

Behavior shared with the HTTP surface:

- Validation runs in domain code (`validateSearchRequest`) before any
  network call; failures are fulfilled as structured results shaped
  `{ error: { code, message } }` — never rejections. Codes match the API
  (`invalid_seed`, `invalid_injected`, `over_limit`, `unsupported_scope`).
- Injected candidates consume zero AI generation quota.
- Checks share the same client verdict cache, bounded queue, and
  429-retry-after handling as the on-page grid. Server-venue checks go
  through `/api/check` and inherit its per-IP rate limits.

## Batch semantics (single-flight, selection, abort, progress)

- **Single-flight gate**: one `batch_check_availability` runs at a time per
  page. A concurrent call fulfills immediately with
  `{ error: { code: "batch_in_progress" }, progress: { done, total }, detail }`
  pointing at aborting the pending call. The gate clears on completion,
  abort, or a user selection change.
- **Exact-replace selection**: a `registries` array replaces the visible
  on-page selection with exactly those ids (unknown ids are reported in
  `unknownRegistries`; an empty array is a structured error). Agent-driven
  changes are in-memory only — they are never persisted to the user's
  saved selection (`localStorage`), are marked on the toggles, and a
  one-click "Restore saved selection" control appears while the live
  selection differs from the saved one.
- **Abort**: executing with the draft's `signal` lets the agent cancel;
  abort stops scheduling new checks, restores the saved selection if the
  batch replaced it, clears the gate, and fulfills with
  `{ error: { code: "batch_aborted" } }`. A user toggling a registry
  mid-batch aborts the batch the same way (the visible selection always
  wins).
- **Result timing**: the tool result resolves only when the whole fan-out
  settles; the results grid paints verdicts live while it runs.

## Progress event (declared extension)

The draft has no progress event. This adapter re-dispatches a namespaced
`CustomEvent("isittaken:toolprogress", { detail: { tool, done, total } })`
on `document.modelContext` (an `EventTarget`) as batch verdicts land. This
is a declared, best-effort extension: browser agents cannot observe page
events — it exists for in-page and page-adjacent tooling. If the spec
standardizes a `toolprogress` event, the adapter is the one file that
changes.

## Discovery request model

```ts
interface SearchRequest {
  /** 1–64 chars, unicode letters/digits, spaces, apostrophes, hyphens, dots. */
  seed: string;

  /** Caller-supplied alternatives (agent clients). Optional. */
  injectedSynonyms?: string[]; // ≤ maxInjectedSynonyms (default 25)
  injectedCreatives?: string[]; // ≤ maxInjectedCreatives (default 25)

  // Not accepted, by design:
  // - scope targets ("/"-containing values) → explicit unsupported error
  // - arbitrary registry URLs → registries come from the descriptor lineup
}
```

Validation (`validateSearchRequest`) runs **before any upstream call** and
throws `SearchValidationError` with one of:

| code                | meaning                                             |
| ------------------- | --------------------------------------------------- |
| `invalid_seed`      | empty, over-length, or unsupported characters       |
| `invalid_injected`  | malformed injected candidate value                  |
| `over_limit`        | count/length limits exceeded                        |
| `unsupported_scope` | scoped npm target — no inferred lookup is performed |

## Discovery use case

```ts
const result = await runDiscovery(validated, {
  sources, // CandidateSource[] (Wordnik today)
  clock,
  limits,
});
```

The HTTP `/api/search` handler calls exactly this function; the WebMCP
`search_names` tool calls it through the same client pipeline with the same
limits; injected candidates follow the same limits,
provenance, and deduplication as HTTP requests.

## Discovery response model

```ts
interface SearchResponse {
  seed: string;
  generatedAtMs: number; // UTC epoch ms
  sources: SourceOutcome[]; // per-source ok | unavailable | skipped
  candidates: ComposedCandidate[];
}

interface ComposedCandidate {
  name: string; // normalized identity
  provenance: ProvenanceKind[]; // set, not a single label:
  // input | wordnik-synonym | wordnik-related |
  // openrouter | injected-synonym | injected-creative
  registryResults: []; // always empty from discovery; availability is a
  // separate operation (below)
}
```

## Availability check use case

```ts
const registry = ctx.serverRegistries.get(registryId); // PackageRegistry
const validation = registry.validate(word); // RegistryValidation
const verdict = await registry.lookup(validation.name); // one upstream lookup
```

`POST /api/check { word, registry }` is a thin shell over exactly this.
Registry ids and their metadata (labels, links, venues) come from the shared
descriptor lineup in `src/domain/registries` — the same client-safe module
the `list_registries` tool exposes.

```ts
interface CheckResponse {
  status: "available" | "taken" | "invalid" | "unknown";
  name: string; // registry-normalized name checked (or rejected)
  checkedAtMs: number;
  reason?: string;
}
```

Server-venue registries (npm, pypi, rubygems, hex, maven) are checked this
way; browser-venue registries (crates, nuget, packagist) refuse `/api/check`
and are fetched directly from their CORS-enabled public endpoints.

## Invariants a transport adapter may rely on

- Sources fail independently; a failed source never blocks other candidates.
- Each accepted check performs at most one upstream registry lookup.
- `unknown` is never presented as `available`.
- Invalid names are classified without network access.
- Equivalent candidates are deduped per registry via the shared normalizers.
- Injected candidates **never consume AI generation quota** — they are
  caller-provided input, not OpenRouter generations.

## Creative generation (authenticated transport only)

Creative generation is out of the transport-neutral boundary for now: it
requires an application session (HTTP cookie) and consumes quota. An agent
client that wants AI-style candidates should supply them via
`injectedCreatives` instead, which receives the same discovery pipeline with
`injected-creative` provenance and zero generation quota.
