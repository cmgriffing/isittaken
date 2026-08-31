---
title: About
description: What Is It Taken is and what it is not.
---

## What this is

A small, honest tool for naming things. Give it a seed word and it gathers
synonyms, related words, and (optionally) AI-generated alternatives, then
checks each candidate against the package registries you select: npm, PyPI,
RubyGems, Hex, Maven Central, crates.io, NuGet, and Packagist.

## What this is not

- **Not a publishing guarantee.** An "available" result means a registry did
  not know the name when we checked. Each registry's own policies decide
  whether a name can actually be published.
- **Not a scope or vendor checker.** npm does not currently provide a
  dependable way to query whether an npm _scope_ (organization) is claimable,
  so we don't pretend to. Namespaced registries are checked by bare name only
  (e.g. the `wordsmith` in `vendor/wordsmith`), under any vendor or group.
- **Not a registry of your searches.** Searches are not stored; only short-
  lived caches of lookups are kept so the service stays fast and cheap.

## The external services involved

- [Wordnik](https://developer.wordnik.com) — synonyms and related words.
- [npm registry](https://registry.npmjs.org), [PyPI](https://pypi.org),
  [RubyGems](https://rubygems.org), [Hex](https://hex.pm),
  [Maven Central](https://central.sonatype.com) — checked through their
  documented JSON APIs.
- [crates.io](https://crates.io), [NuGet](https://api.nuget.org),
  [Packagist](https://packagist.org) — fetched directly from your browser via
  their CORS-enabled public APIs.
- [OpenRouter](https://openrouter.ai) — optional AI-generated name ideas for
  signed-in users.
- [GitHub OAuth](https://docs.github.com/en/developers/apps/building-oauth-apps)
  — optional sign-in for the AI feature, with no repository access.
