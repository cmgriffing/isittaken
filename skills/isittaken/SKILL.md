---
name: isittaken
description: >
  Check package-name availability across nine registries (npm, PyPI,
  crates.io, RubyGems, NuGet, Hex, Maven, Go, Packagist) directly from the
  terminal with honest classification. Use when the user wants to check
  whether a package/library/gem/crate name is available, find an available
  name for a new package, pick a claimable package name, or verify name
  availability before publishing. Triggers: "is this package name taken",
  "check name availability", "find an available npm name", "is <name>
  available on <registry>", "package naming".
---

# isittaken — honest package-name availability checks

`isittaken check` answers one question per (name, venue) pair: is this name
available? It classifies conservatively and never invents names for you.

## When to use

- You are about to publish a package and need to know whether the name is
  free on the venue(s) you will publish to.
- The user asks whether a package/library/crate/gem name is taken or
  available.
- You are brainstorming names for a new package and want to narrow a list of
  candidates to the claimable ones.

## When NOT to use

- You want the tool to invent candidate names. It does not generate names —
  **you brainstorm them yourself** and pass them as arguments.
- You need scoped npm names (`@scope/pkg`): scoped-name claimability is
  intentionally unsupported; such input classifies as `invalid`.

## Workflow

1. **Brainstorm candidates yourself.** Generate a spread of plausible names —
   exact topic words, hyphenated compounds, short compound words. Multi-word
   phrases are accepted; npm collapses whitespace runs to hyphens
   (`"fuzzy picker"` is checked as `fuzzy-picker`).
2. **Check them:**

   ```bash
   npx isittaken check <names...> --json
   # or: pnpm dlx isittaken check <names...> --json
   ```

   `--json` is the primary machine-readable output. The default output is a
   human table. One run accepts any number of names.

3. **Interpret the results** (see below). Only `available` is claimable.
4. **Verify before publishing.** Before relying on any result — especially a
   fuzzy one — confirm the name on the venue itself (its registry page or
   official search). The venue is the authority; this tool observes, it does
   not guarantee.

## Command reference

```
isittaken check <names...> [options]

  -r, --registry <ids>   comma-separated venue ids to scope the run
                         (default: all nine venues)
  --json                 machine-readable JSON output
  --concurrency <n>      max concurrent lookups per venue (default 10)
  --timeout <ms>         per-venue lookup timeout (default 10000)
```

Venue ids: `npm`, `pypi`, `crates`, `rubygems`, `nuget`, `hex`, `maven`, `go`,
`packagist`.

Exit codes: `0` = at least one (name, venue) result is `available`; `1` = none
available (all `taken`/`invalid`/`unknown`); `2` = usage error (no names,
unknown venue id, bad flag value).

## Interpreting results

Each result has a `status` and the venue-normalized `name` that was checked:

| status      | meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `available` | The venue's documented not-found response — **claimable**.                                                                            |
| `taken`     | A parseable success response — the name exists.                                                                                       |
| `invalid`   | Locally rejected for that venue's naming rules; no request was made.                                                                  |
| `unknown`   | Rate-limited, timed out, or ambiguous — **treat as unavailable-for-now**; retry or check manually. Never read `unknown` as available. |

Fuzzy results additionally carry `fuzzy: true` plus a `reason` describing what
was consulted. They appear in the table as e.g. `available (fuzzy)`:

- **`fuzzy: true` is a lead to verify, not a verdict.** Bare-word checks on
  `maven`, `go`, and `packagist` consult that venue's search index, which may
  lag the registry. Before relying on a fuzzy `available`, check the venue
  directly.
- Exact venues (`npm`, `pypi`, `crates`, `rubygems`, `nuget`, `hex`) never
  produce fuzzy results: their not-found responses are definitive.

## Scoping and precision

- Default scope is **all nine venues**. Scope with `-r`:

  ```bash
  npx isittaken check my-name -r npm,pypi,crates   # zero-fuzz: all exact venues
  ```

  When you need guaranteed definitive results, scope to exact venues only
  (e.g. `-r npm,pypi,crates`) — no result can then carry `fuzzy: true`.

- **Qualified input upgrades fuzzy venues to exact checks:**
  - packagist: `vendor/name` (e.g. `symfony/console`) → direct p2 metadata
    lookup, non-fuzzy.
  - maven: `group:artifact` (e.g. `org.apache.commons:commons-lang3`) →
    maven-metadata lookup, non-fuzzy.
  - go: a full module path (e.g. `github.com/spf13/cobra`) → module proxy
    lookup, non-fuzzy.
- `go` bare-word search is best-effort: pkg.go.dev frequently rate-limits
  non-browser clients; when blocked the result is an honest `unknown` with a
  reason.
- A scoped name like `foo/bar` is checked per venue: venues that cannot
  check it classify it `invalid` (with a reason) without aborting the run;
  only venues that accept qualified identifiers check it.

## Honesty contract

- Availability is **observed, not guaranteed**: a name can be claimed by
  someone else between your check and your publish. Verify on the venue
  immediately before publishing.
- The venue is the authority; this tool never overrides it.
- Unknown means unknown. The tool never presents `unknown` as `available`.

## Example JSON output

```json
{
  "venues": ["npm", "pypi", "crates", "rubygems", "nuget", "hex", "maven", "go", "packagist"],
  "candidates": [
    {
      "input": "fuzzy picker",
      "results": {
        "npm": { "status": "available", "name": "fuzzy-picker", "checkedAtMs": 1730000000000 },
        "pypi": {
          "status": "invalid",
          "name": "fuzzy picker",
          "checkedAtMs": 1730000000001,
          "reason": "Name cannot contain spaces."
        },
        "packagist": {
          "status": "available",
          "name": "fuzzy-picker",
          "checkedAtMs": 1730000000002,
          "fuzzy": true,
          "reason": "not matched in the Packagist search index (search indexes may lag the registry)"
        }
      }
    }
  ]
}
```

Only results that carry `fuzzy`/`reason` include those fields; exact venues
omit them.
