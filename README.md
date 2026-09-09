# isittaken

Honest, multi-registry package-name availability checks — as a web app, a
CLI for agents, and a shared core library.

Type a seed word: the app collects synonyms and related words (Wordnik),
optionally invents creative alternatives (OpenRouter, authenticated users),
and checks every candidate across the package registries you select — npm,
PyPI, RubyGems, Hex, Maven Central, and Go (via this site's API), plus
crates.io, NuGet, Packagist (fetched directly from your browser) — with honest
`available | taken | invalid | unknown` classification. `unknown` is never
presented as available.

The CLI (`isittaken check`) checks bare or venue-qualified names across **nine
registries** — npm, PyPI, crates.io, RubyGems, NuGet, Hex, Maven, Go, and
Packagist — with the same honest classification, designed for humans and AI
agents alike.

## Repository layout (pnpm + Turborepo workspace)

```
apps/web      # Astro + Netlify web app — search, availability, WebMCP
apps/cli      # `isittaken` CLI — `check` command across nine venues
packages/core # @isittaken/core — transport-neutral availability domain
skills/       # AI Skills (skills.sh) teaching agents how to use the CLI
docs/         # deployment, scheduled functions, and the search contract
```

- **`packages/core`** owns the shared domain: the `PackageRegistry` port and
  nine venue adapters, candidate normalization/deduplication, request
  validation, honest classification, the availability-check primitive
  (`checkCandidatesAcrossRegistries`), and the shared registry HTTP helper
  that stamps every upstream request with an explicit
  `User-Agent: isittaken/<version> (+<repo-url>)`.
- **`apps/web`** composes the core with web-only capabilities (Wordnik,
  OpenRouter creative generation, quota, sessions, server-venue result
  caching) behind its `/api/*` Netlify Functions.
- **`apps/cli`** composes the core with raw name arguments — no keys, no
  config, no web machinery.

## Workspace commands (repository root)

```bash
pnpm install        # install all workspace packages
pnpm build          # turbo: build all packages
pnpm lint           # turbo: eslint everywhere
pnpm typecheck      # turbo: tsc --noEmit everywhere
pnpm test           # turbo: vitest everywhere
pnpm format:check   # prettier check (root config)
```

## Web app development (from `apps/web`)

```bash
cd apps/web
cp .env.example .env
pnpm migrate       # local SQLite migrations
pnpm dev           # http://localhost:4321
pnpm verify        # full gate chain (lint, format, checks, tests, browser, build shape)
```

Netlify deployment: leave the site's **base directory** and **package
directory** unset — the repository-root `netlify.toml` drives the build
(build command, publish dir, Functions dir, `/api/*` behavior) and its
file-based settings override any stale UI values. See
[docs/deployment.md](docs/deployment.md).

## CLI usage (from `apps/cli`, or via the published npm package)

```bash
isittaken check <names...> [options]

isittaken check my-package
isittaken check "fuzzy picker" other-name --json      # phrases normalized per venue
isittaken check mylib -r npm,pypi,crates              # scope to exact-only venues
isittaken check symfony/console -r packagist          # qualified input -> exact check
```

| Option                 | Meaning                                     | Default         |
| ---------------------- | ------------------------------------------- | --------------- |
| `-r, --registry <ids>` | comma-separated venue ids to scope the run  | all nine venues |
| `--json`               | machine-readable JSON (preferred by agents) | human table     |
| `--concurrency <n>`    | max concurrent lookups per venue            | 10              |
| `--timeout <ms>`       | per-venue lookup timeout                    | 10000           |

Venue ids: `npm`, `pypi`, `crates`, `rubygems`, `nuget`, `hex` (exact,
definitive checks) and `maven`, `go`, `packagist` (fuzzy for bare words —
results carry `fuzzy: true`; qualified input upgrades them to exact checks).
Go bare-word search is best-effort and honestly reports `unknown` when
pkg.go.dev rate-limits the client.

`--json` output is agent-first: a top-level `summary` rollup answers "what
can I claim?" directly — `anyAvailable`, per-status `counts`, and an
`available` list mapping each input to its exact venues (definitive) and its
`fuzzyVenues` (search-index leads to verify). The human output is vertical:
one bordered, colored block per input with stacked venue rows (green
available / red taken / yellow unknown / dim invalid / cyan fuzzy marker)
followed by per-input verdict lines; color is automatically disabled for
piped output (`NO_COLOR` honored). Non-JSON runs also stream per-venue
progress checkpoints to stderr (`[2/9] pypi — 3 available, 1 taken (150ms)`)
while stdout stays clean; `--json` output is never mixed with progress.

Exit codes: `0` = at least one (name, venue) result is `available`; `1` =
none available; `2` = usage error.

## AI Skills

`skills/isittaken/SKILL.md` teaches agents the workflow (brainstorm
candidates → `npx isittaken check <names...> --json` → interpret results with
the honesty contract). Installable via [skills.sh](https://skills.sh) /
`npx skills add cmgriffing/isittaken`.

## Documentation

- [Deployment and operations](docs/deployment.md) — environment variables,
  GitHub OAuth registration, Turso, OpenRouter safeguards, rollback controls.
- [Scheduled functions](docs/scheduled-functions.md) — pruning shards,
  schedules, and local one-shot invocation.
- [WebMCP tools](docs/webmcp-contract.md) — the browser tool adapter
  (registered on the home page when the draft `document.modelContext` API is
  present) with the four tools (`list_registries`, `search_names`,
  `check_availability`, `batch_check_availability`), their single-flight/
  abort/selection semantics, and the declared `isittaken:toolprogress`
  extension, over the transport-neutral request/response models shared by the
  HTTP surface (implemented on top of `@isittaken/core`).

## Scope notes

- npm **scope** claimability is intentionally unsupported: npm provides no
  dependable signal, and both the web app and the CLI refuse scoped targets
  explicitly (`invalid` per venue in the CLI).
- Availability is observed, not guaranteed — each venue remains the
  authority. Verify on the venue before publishing.
- Supported registries: npm, PyPI, RubyGems, Hex, Maven Central, and Go
  (server venues, checked via this site's API — Go results are fuzzy leads to
  verify), plus crates.io, NuGet, and Packagist (browser venues, fetched
  directly from the visitor's browser).
- Every outbound registry request made by the CLI or the server carries an
  explicit identifying `User-Agent`; browser-venue direct fetches cannot set
  one (browsers treat it as a forbidden header).

## License

See [LICENSE](LICENSE).
