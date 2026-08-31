---
title: Privacy
description: What we store, what we don't, and for how long.
---

## Without an account

You can search anonymously. We do not store your searches. We keep short-
lived caches of upstream lookups (Wordnik results, server-side registry
availability verdicts) to protect those services and keep the site fast.
Browser-venue registries (crates.io, NuGet, Packagist) are fetched directly
by your browser and their verdicts stay in your browser's local storage —
they are never reported back to us. Cache entries expire within minutes to
days depending on the kind of data, and scheduled jobs prune them.

## With an account (optional)

Signing in with GitHub exists only to meter the paid AI feature:

- We receive your **GitHub numeric ID, login name, and avatar URL** — nothing
  else. We request **no scopes**: no repository, email, or organization
  access.
- We **never keep the GitHub access token**. It is used once, in memory, to
  read your identity, and then discarded.
- We store your local user record and a session record: a hashed session
  cookie value, creation and expiry timestamps. Logging out deletes the
  session.
- We store aggregate AI usage counters (request counts and token totals per
  user and for the whole application) to enforce quotas and the spending
  ceiling.

## Cookies

Two short-lived cookies at most: an OAuth handshake cookie during sign-in
(minutes), and a session cookie (`HttpOnly`, `SameSite=Lax`) while signed in
(days). No analytics, tracking, or advertising cookies.
