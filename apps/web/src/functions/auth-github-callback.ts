import type { AppContext } from "./composition";
import { errorResponse, withCorrelationId } from "./http";
import { parseCookies, serializeCookie } from "../lib/cookies";
import { randomToken, sha256Hex, verifyValue } from "../lib/crypto";
import { decodeOAuthCookie, OAUTH_COOKIE } from "./auth-github-start";
import { logger } from "../lib/logger";

interface GitHubTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  error?: unknown;
}

interface GitHubIdentity {
  id?: unknown;
  login?: unknown;
  avatar_url?: unknown;
}

/**
 * GitHub OAuth callback. Validates state and PKCE against the signed
 * start-cookie, exchanges the short-lived code server-side, fetches the
 * authenticated identity, upserts the user by GitHub's immutable numeric ID,
 * and immediately discards the GitHub access token. Only the application's
 * own opaque session cookie survives.
 */
export function createAuthCallbackFunction(
  ctx: AppContext,
): (request: Request) => Promise<Response> {
  const { config } = ctx;

  return withCorrelationId(async (request, correlationId): Promise<Response> => {
    if (request.method !== "GET") {
      return errorResponse("method_not_allowed", "Use GET.", 405, { allow: "GET" });
    }
    if (!config.github.clientId || !config.github.clientSecret) {
      return errorResponse("auth_unconfigured", "GitHub authentication is not configured.", 503);
    }

    const clearOauthCookie = {
      "set-cookie": serializeCookie(OAUTH_COOKIE, "", {
        expired: true,
        secure: config.session.cookieSecure,
      }),
      "cache-control": "no-store",
    };

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return errorResponse("invalid_callback", "Missing code or state.", 400, clearOauthCookie);
    }

    const cookies = parseCookies(request.headers.get("cookie"));
    const rawCookie = cookies[OAUTH_COOKIE];
    const decoded = rawCookie ? decodeOAuthCookie(rawCookie) : null;
    if (!rawCookie || !decoded) {
      return errorResponse(
        "invalid_callback",
        "Missing or corrupted OAuth state cookie.",
        400,
        clearOauthCookie,
      );
    }
    const signatureValid = await verifyValue(
      rawCookie.slice(0, rawCookie.lastIndexOf(".")),
      decoded.signature,
      config.github.clientSecret,
    );
    if (!signatureValid) {
      logger.warn("oauth_cookie_signature_invalid", { correlationId });
      return errorResponse(
        "invalid_callback",
        "OAuth state cookie failed verification.",
        400,
        clearOauthCookie,
      );
    }

    const { payload } = decoded;
    const nowMs = ctx.clock.nowMs();
    if (nowMs - payload.issuedAtMs > config.session.oauthCookieTtlMs) {
      return errorResponse(
        "invalid_callback",
        "OAuth state expired; start again.",
        400,
        clearOauthCookie,
      );
    }
    if (state !== payload.state) {
      return errorResponse("invalid_callback", "State mismatch.", 400, clearOauthCookie);
    }

    // Server-side code exchange + identity fetch. The access token never
    // leaves this function's scope, so it is discarded immediately after.
    async function exchangeAndFetchIdentity(): Promise<GitHubIdentity> {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        signal: AbortSignal.timeout(config.github.timeoutMs),
        body: JSON.stringify({
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code,
          code_verifier: payload.verifier,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error("exchange_failed");
      }
      const body = (await tokenResponse.json()) as GitHubTokenResponse;
      if (typeof body.access_token !== "string" || body.access_token.length === 0) {
        throw new Error("no_access_token");
      }
      const accessToken: string = body.access_token;

      const identityResponse = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "isittaken",
        },
        signal: AbortSignal.timeout(config.github.timeoutMs),
      });
      if (!identityResponse.ok) {
        throw new Error("identity_failed");
      }
      return (await identityResponse.json()) as GitHubIdentity;
    }

    let identity: GitHubIdentity;
    try {
      identity = await exchangeAndFetchIdentity();
    } catch (error) {
      logger.warn("oauth_exchange_failed", {
        correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      const message =
        error instanceof Error && error.message === "identity_failed"
          ? "Could not read the GitHub identity."
          : "GitHub code exchange failed.";
      return errorResponse("exchange_failed", message, 502, clearOauthCookie);
    }

    const githubId = typeof identity.id === "number" ? String(identity.id) : null;
    const githubLogin =
      typeof identity.login === "string" && identity.login.length > 0 ? identity.login : null;
    if (!githubId || !githubLogin) {
      return errorResponse(
        "identity_failed",
        "GitHub identity fields are missing.",
        502,
        clearOauthCookie,
      );
    }
    const avatarUrl = typeof identity.avatar_url === "string" ? identity.avatar_url : null;

    const user = await ctx.users.upsertByGithubId(
      { githubId, githubLogin, avatarUrl },
      ctx.clock.nowMs(),
    );

    const token = randomToken(32);
    const now = ctx.clock.nowMs();
    await ctx.sessions.create({
      tokenHash: await sha256Hex(token),
      userId: user.id,
      createdAtMs: now,
      expiresAtMs: now + config.session.ttlMs,
      lastSeenAtMs: now,
    });

    logger.info("auth_login_succeeded", { correlationId, userId: user.id });

    const location = payload.returnTo || "/";
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": serializeCookie(config.session.cookieName, token, {
          maxAgeSeconds: Math.ceil(config.session.ttlMs / 1_000),
          secure: config.session.cookieSecure,
          httpOnly: true,
          sameSite: "Lax",
        }),
        "cache-control": "no-store",
      },
    });
  });
}
