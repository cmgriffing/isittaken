---
title: Methodology
description: How candidate names are collected, validated, and classified.
---

## Candidate collection

1. **Your seed word** becomes the first candidate.
2. **Wordnik** contributes synonyms and related words for the seed.
3. **Injected candidates** — callers (including future agent clients) may
   supply their own synonym/creative alternatives, which receive their own
   provenance and never consume AI quota.
4. **Creative generation** (optional, signed-in users) asks a language model
   for structured suggestions.

All candidates are normalized (trimmed, lowercased, whitespace-collapsed) and
deduplicated. When several sources produce the same name, the result keeps a
_set_ of provenance labels.

## Where checks run

- **Server venue** (npm, PyPI, RubyGems, Hex, Maven Central): your browser
  asks this site's `/api/check` endpoint, which performs a single upstream
  lookup per request and caches the verdict briefly. Requests are rate
  limited per client IP and per registry to stay polite with upstreams.
- **Browser venue** (crates.io, NuGet, Packagist): your browser fetches the
  registry's public, CORS-enabled API directly — no server round-trip — so
  requests come from your own connection. Verdicts are cached in your
  browser's local storage and revalidated in the background when stale.

## Availability classification

Every registry maps upstream responses to one of four verdicts:

| Result      | Meaning                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `taken`     | The registry returned metadata proving the name exists (for Maven and Packagist, under any group or vendor).                                  |
| `available` | The registry returned its documented not-found response for a valid name, or a search-style result set conclusively contained no exact match. |
| `invalid`   | The name fails the registry's own naming rules; we never queried the registry for it.                                                         |
| `unknown`   | Timeout, rate limit, or any response that doesn't prove presence or absence. We never guess.                                                  |

Registry-specific normalization applies before checking (for example PyPI
collapses `foo_bar` and `foo-bar` to the same project per PEP 503). Every
availability answer includes the time it was checked and the exact name that
was checked. "Available" is an observation, not a reservation — each registry
remains the authority on publishing.

## What we deliberately don't do

- **No scope lookups.** npm provides no dependable supported signal for scope
  claimability; scraping or inference would produce lies, so the feature
  doesn't exist here.
- **No packages-inside-scope search** for the same reason.
- **No Go (pkg.go.dev) checks.** It has no official JSON search API, and HTML
  scraping would be both fragile and impolite.
- **No guaranteed fresh answers.** Results may be cached briefly by source
  policy; available-name results get the shortest freshness window because
  they can become taken at any time.
