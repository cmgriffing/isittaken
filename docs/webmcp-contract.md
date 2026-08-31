# Transport-Neutral Contracts (future WebMCP adapter)

The application's core operations are callable without HTTP. Today the
Netlify Functions translate JSON requests into the models below; a future
WebMCP tool adapter can map tool arguments to the _same_ models and map the
result back to tool content, without duplicating validation, provenance,
deduplication, or availability rules.

There are two core operations, matching the split HTTP surface:

1. **Candidate discovery** — seed (+ optional injected candidates) → names
   with provenance. No registry contact.
2. **Single-registry availability check** — one name, one registry → one
   verdict. This is the natural shape for a future "check name X on registry
   Y" tool.

WebMCP registration is deliberately **not** shipped in this release: the
draft browser API is still evolving. The only requirement for a future
adapter is that it lives in an isolated client module and translates between
the draft API and the contracts below.

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

The HTTP `/api/search` handler calls exactly this function. A WebMCP adapter
would call it the same way; injected candidates follow the same limits,
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
descriptor lineup in `src/domain/registries` — the same client-safe module a
"list supported registries" tool would expose.

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
