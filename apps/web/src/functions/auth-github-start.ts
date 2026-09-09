import type { AppContext } from "./composition";
import { errorResponse } from "./http";
import { serializeCookie } from "../lib/cookies";
import { createPkcePair, randomToken, signValue } from "../lib/crypto";

const OAUTH_COOKIE = "iit_oauth";

interface OAuthCookiePayload {
  state: string;
  verifier: string;
  returnTo: string;
  issuedAtMs: number;
}

/**
 * Only relative, same-site return paths are honored: a single leading slash
 * that is not protocol-relative, with no scheme.
 */
export function safeReturnPath(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (value.includes("://")) return "/";
  return value;
}

/**
 * GitHub OAuth start. No scopes are requested. High-entropy state and an
 * S256 PKCE pair are issued in a short-lived, signed, protected cookie
 * before redirecting the visitor to GitHub's authorization endpoint.
 */
export function createAuthStartFunction(ctx: AppContext): (request: Request) => Promise<Response> {
  const { config } = ctx;

  return async function authStart(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse("method_not_allowed", "Use GET.", 405, { allow: "GET" });
    }
    if (!config.github.clientId || !config.github.clientSecret) {
      return errorResponse("auth_unconfigured", "GitHub authentication is not configured.", 503);
    }

    const url = new URL(request.url);
    const returnTo = safeReturnPath(url.searchParams.get("return_to"));

    const state = randomToken(32);
    const { verifier, challenge } = await createPkcePair();

    const payload: OAuthCookiePayload = {
      state,
      verifier,
      returnTo,
      issuedAtMs: ctx.clock.nowMs(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = await signValue(encoded, config.github.clientSecret);

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", config.github.clientId);
    authorizeUrl.searchParams.set("state", state);
    // No `scope` parameter: identity only, no repository or organization access.
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl.toString(),
        "set-cookie": serializeCookie(OAUTH_COOKIE, `${encoded}.${signature}`, {
          maxAgeSeconds: Math.ceil(config.session.oauthCookieTtlMs / 1_000),
          secure: config.session.cookieSecure,
          httpOnly: true,
          sameSite: "Lax",
        }),
        "cache-control": "no-store",
      },
    });
  };
}

export { OAUTH_COOKIE };
export type { OAuthCookiePayload };

export function decodeOAuthCookie(
  raw: string,
): { payload: OAuthCookiePayload; signature: string } | null {
  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as OAuthCookiePayload;
    if (
      typeof payload.state !== "string" ||
      typeof payload.verifier !== "string" ||
      typeof payload.returnTo !== "string" ||
      typeof payload.issuedAtMs !== "number"
    ) {
      return null;
    }
    return { payload, signature };
  } catch {
    return null;
  }
}
