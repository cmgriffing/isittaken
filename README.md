# isittaken

A small web service to find available package names on package repositories.

Type a seed word: the app collects synonyms and related words (Wordnik),
optionally invents creative alternatives (OpenRouter, authenticated users),
and checks every candidate across the package registries you select — npm,
PyPI, RubyGems, Hex, Maven Central (via this site's API), and crates.io,
NuGet, Packagist (fetched directly from your browser) — with honest
`available | taken | invalid | unknown` classification. `unknown` is never
presented as available.

## Stack

- **Astro (static output)** + **Preact islands** — prebuilt HTML, JS only for
  the search and authentication islands.
- **Netlify Functions** (standalone, in `netlify/functions/`) behind friendly
  `/api/*` redirects, plus scheduled pruning functions.
- **SQLite / Turso** via `@libsql/client` — one repository code path for
  local development and production.
- Strict TypeScript throughout.

## Development

```bash
pnpm install
cp .env.example .env
pnpm migrate      # local SQLite migrations
pnpm dev          # http://localhost:4321
```

## Verification

```bash
pnpm lint            # eslint (flat config)
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest: unit, adapter, API, contract, journey tests
pnpm test:browser    # playwright against the static build
pnpm migrate         # apply migrations
node scripts/verify-production-build.mjs   # static build shape check
```

## Documentation

- [Deployment and operations](docs/deployment.md) — environment variables,
  GitHub OAuth registration, Turso, OpenRouter safeguards, rollback controls.
- [Scheduled functions](docs/scheduled-functions.md) — pruning shards,
  schedules, and local one-shot invocation.
- [Search contract](docs/webmcp-contract.md) — the transport-neutral request/
  response models a future WebMCP adapter will consume.

## Scope notes

- npm **scope** claimability is intentionally unsupported: npm provides no
  dependable signal, and the app refuses scoped targets explicitly.
- Availability is observed, not guaranteed — each registry remains the
  authority.
- Supported registries: npm, PyPI, RubyGems, Hex, Maven Central (server
  venue), and crates.io, NuGet, Packagist (browser venue). Go (pkg.go.dev) is
  unsupported: no official JSON search API.
