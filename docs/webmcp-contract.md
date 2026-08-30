# Transport-Neutral Search Contract (future WebMCP adapter)

The application's core search operation is callable without HTTP. Today the
Netlify Functions translate JSON requests into the models below; a future
WebMCP tool adapter can map tool arguments to the _same_ models and map the
result back to tool content, without duplicating validation, provenance,
deduplication, or availability rules.

WebMCP registration is deliberately **not** shipped in this release: the
draft browser API is still evolving. The only requirement for a future
adapter is that it lives in an isolated client module and translates between
the draft API and the contract below.

## Request model

```ts
interface SearchRequest {
  /** 1–64 chars, unicode letters/digits, spaces, apostrophes, hyphens, dots. */
  seed: string;

  /** Caller-supplied alternatives (agent clients). Optional. */
  injectedSynonyms?: string[]; // ≤ maxInjectedSynonyms (default 25)
  injectedCreatives?: string[]; // ≤ maxInjectedCreatives (default 25)

  // Not accepted, by design:
  // - scope targets ("/"-containing values) → explicit unsupported error
  // - arbitrary registry URLs → registries are configured server-side
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

## Use case

```ts
const result = await runDiscovery(validated, {
  sources, // CandidateSource[] (Wordnik today)
  registries, // PackageRegistry[] (npm today)
  clock,
  limits,
  registryConcurrency,
});
```

The HTTP `/api/search` handler calls exactly this function. A WebMCP adapter
would call it the same way; injected candidates follow the same limits,
provenance, deduplication, and availability behavior as HTTP requests.

## Response model

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
  registryResults: RegistryResult[];
}

interface RegistryResult {
  registry: string; // "npm" today
  name: string; // registry-normalized name checked
  status: "available" | "taken" | "invalid" | "unknown";
  checkedAtMs: number;
  reason?: string;
}
```

Invariants a transport adapter may rely on:

- Sources fail independently; a failed source never blocks other candidates.
- `unknown` is never presented as `available`.
- Invalid names are classified without network access.
- Equivalent candidates are checked once; provenance is merged.
- Injected candidates **never consume AI generation quota** — they are
  caller-provided input, not OpenRouter generations.

## Creative generation (authenticated transport only)

Creative generation is out of the transport-neutral boundary for now: it
requires an application session (HTTP cookie) and consumes quota. An agent
client that wants AI-style candidates should supply them via
`injectedCreatives` instead, which performs the same npm checks with
`injected-creative` provenance and zero generation quota.
