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

## npm classification

| Result      | Meaning                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `taken`     | npm returned package metadata for the name.                                                  |
| `available` | npm returned its documented not-found response for a valid unscoped name.                    |
| `invalid`   | The name could not be published as an unscoped npm package; we never queried npm for it.     |
| `unknown`   | Timeout, rate limit, or any response that doesn't prove presence or absence. We never guess. |

Every availability answer includes the time it was checked. "Available" is an
observation, not a reservation — npm remains the authority on publishing.

## What we deliberately don't do

- **No scope lookups.** npm provides no dependable supported signal for scope
  claimability; scraping or inference would produce lies, so the feature
  doesn't exist here.
- **No packages-inside-scope search** for the same reason.
- **No guaranteed fresh answers.** Results may be cached briefly by source
  policy; available-name results get the shortest freshness window because
  they can become taken at any time.
