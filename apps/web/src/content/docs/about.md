---
title: About
description: What Is It Taken is and what it is not.
---

## What this is

A small, honest tool for naming things. Give it a seed word and it gathers
synonyms, related words, and (optionally) AI-generated alternatives, then
checks each candidate against the public npm registry.

## What this is not

- **Not a publishing guarantee.** An "available" result means npm's registry
  did not know the name when we checked. npm's own policies decide whether a
  name can actually be published.
- **Not a scope checker.** npm does not currently provide a dependable way to
  query whether an npm _scope_ (organization) is claimable, so we don't
  pretend to. We also don't look inside other people's scopes.
- **Not a registry of your searches.** Searches are not stored; only short-
  lived caches of lookups are kept so the service stays fast and cheap.

## The external services involved

- [Wordnik](https://developer.wordnik.com) — synonyms and related words.
- [npm registry](https://registry.npmjs.org) — package metadata and
  availability signals.
- [OpenRouter](https://openrouter.ai) — optional AI-generated name ideas for
  signed-in users.
- [GitHub OAuth](https://docs.github.com/en/developers/apps/building-oauth-apps)
  — optional sign-in for the AI feature, with no repository access.
