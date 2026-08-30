import type { AppContext } from "./composition";
import type { UserRecord } from "../domain/ports";
import { isSameOriginRequest, jsonResponse, errorResponse } from "./http";
import { parseCookies, serializeCookie } from "../lib/cookies";
import { sha256Hex } from "../lib/crypto";

export interface ResolvedSession {
  session: { userId: string; tokenHash: string; expiresAtMs: number };
  user: UserRecord | null;
}

/** Resolve the browser's session cookie into a valid session + user, if any. */
export async function resolveSession(
  ctx: AppContext,
  request: Request,
): Promise<ResolvedSession | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies[ctx.config.session.cookieName];
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const session = await ctx.sessions.findValid(tokenHash, ctx.clock.nowMs());
  if (!session) return null;

  const user = await ctx.users.getById(session.userId).catch(() => null);
  return {
    session: {
      userId: session.userId,
      tokenHash: session.tokenHash,
      expiresAtMs: session.expiresAtMs,
    },
    user,
  };
}

/**
 * Session status endpoint. Static pages determine personalized state through
 * this client-side request rather than page SSR.
 */
export function createSessionStatusFunction(
  ctx: AppContext,
): (request: Request) => Promise<Response> {
  return async function sessionStatus(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse("method_not_allowed", "Use GET.", 405, { allow: "GET" });
    }

    const resolved = await resolveSession(ctx, request);
    if (!resolved || !resolved.user) {
      return jsonResponse({ authenticated: false }, 200, { "cache-control": "no-store" });
    }

    void ctx.sessions.touch(resolved.session.tokenHash, ctx.clock.nowMs()).catch(() => {
      // last-seen refresh is best-effort
    });

    return jsonResponse(
      {
        authenticated: true,
        user: {
          login: resolved.user.githubLogin,
          avatarUrl: resolved.user.avatarUrl,
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  };
}

/**
 * Logout. Revokes the stored session, expires the browser cookie, and
 * requires same-origin request metadata (cookie-authenticated POST).
 */
export function createLogoutFunction(ctx: AppContext): (request: Request) => Promise<Response> {
  return async function logout(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Use POST.", 405, { allow: "POST" });
    }

    if (!isSameOriginRequest(request, new URL(ctx.config.app.publicSiteUrl).origin)) {
      return errorResponse("cross_origin_forbidden", "Logout requires a same-origin request.", 403);
    }

    const resolved = await resolveSession(ctx, request);
    if (resolved) {
      await ctx.sessions.revoke(resolved.session.tokenHash);
    }

    return jsonResponse({ ok: true }, 200, {
      "cache-control": "no-store",
      "set-cookie": serializeExpiredSessionCookie(ctx),
    });
  };
}

function serializeExpiredSessionCookie(ctx: AppContext): string {
  return serializeCookie(ctx.config.session.cookieName, "", {
    expired: true,
    secure: ctx.config.session.cookieSecure,
  });
}
