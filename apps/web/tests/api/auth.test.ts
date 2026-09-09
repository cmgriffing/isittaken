import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthStartFunction, OAUTH_COOKIE } from "../../src/functions/auth-github-start";
import { createAuthCallbackFunction } from "../../src/functions/auth-github-callback";
import {
  createLogoutFunction,
  createSessionStatusFunction,
} from "../../src/functions/auth-session";
import { createTestContext, type TestContextOptions } from "../helpers/test-context";
import type { AppContext } from "../../src/functions/composition";

const github = { clientId: "cid_test", clientSecret: "secret_test" };

function makeOptions(extra: Partial<TestContextOptions> = {}): TestContextOptions {
  return { github, ...extra };
}

let ctx: AppContext;
let cleanup: () => void;

beforeEach(async () => {
  const context = await createTestContext(makeOptions());
  ctx = context.ctx;
  cleanup = context.cleanup;
});

afterAll(() => {
  cleanup?.();
});

function cookieValue(response: Response, name: string): string | undefined {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return match?.[1];
}

function cookieHeaderFrom(name: string, value: string): string {
  return `${name}=${value}`;
}

async function login(fetchMock: ReturnType<typeof vi.fn>, returnTo = "/welcome") {
  const start = createAuthStartFunction(ctx);
  const startResponse = await start(
    new Request(`http://localhost/api/auth/github/start?return_to=${returnTo}`),
  );
  expect(startResponse.status).toBe(302);

  const oauthCookie = cookieValue(startResponse, OAUTH_COOKIE) as string;
  const location = new URL(startResponse.headers.get("location") as string);
  const state = location.searchParams.get("state") as string;
  const code = "oauth-code-123";

  const callback = createAuthCallbackFunction(ctx);
  const callbackResponse = await callback(
    new Request(`http://localhost/api/auth/github/callback?code=${code}&state=${state}`, {
      headers: { cookie: cookieHeaderFrom(OAUTH_COOKIE, oauthCookie) },
    }),
  );
  return { startResponse, location, callbackResponse };
}

describe("GitHub authentication", () => {
  it("starts login without scopes, with S256 PKCE and protected cookie", async () => {
    const start = createAuthStartFunction(ctx);
    const response = await start(
      new Request("http://localhost/api/auth/github/start?return_to=/deep/page"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(github.clientId);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBeNull();

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=");
    // Local test env runs over http, so Secure is off; deployed envs force it on.
    expect(setCookie).toMatch(/^(.*(Secure|Max-Age))*.*$/);

    const oauthValue = cookieValue(response, OAUTH_COOKIE) as string;
    expect(oauthValue.length).toBeGreaterThan(40);
  });

  it("sanitizes unsafe return paths", async () => {
    const { safeReturnPath } = await import("../../src/functions/auth-github-start");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("/ok/path")).toBe("/ok/path");
  });

  it("completes login, issues a session, and never persists the GitHub token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_TOPSECRET", token_type: "bearer" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 4242, login: "octo", avatar_url: "http://a.png" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { location, callbackResponse } = await login(fetchMock);
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe("/welcome");

    const sessionCookie = cookieValue(callbackResponse, ctx.config.session.cookieName);
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).not.toContain("gho_");
    const sessionSetCookie = callbackResponse.headers.get("set-cookie") ?? "";
    expect(sessionSetCookie).toContain("HttpOnly");
    expect(sessionSetCookie).toContain("SameSite=Lax");

    // GitHub token must not survive anywhere in the database.
    const users = await ctx.db.execute("SELECT * FROM users");
    const sessions = await ctx.db.execute("SELECT * FROM sessions");
    for (const row of [...users.rows, ...sessions.rows]) {
      expect(JSON.stringify(row)).not.toContain("gho_");
    }

    const status = createSessionStatusFunction(ctx);
    const statusResponse = await status(
      new Request("http://localhost/api/auth/session", {
        headers: {
          cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie as string),
        },
      }),
    );
    const body = (await statusResponse.json()) as {
      authenticated: boolean;
      user?: { login: string; avatarUrl: string };
    };
    expect(body.authenticated).toBe(true);
    expect(body.user?.login).toBe("octo");
    expect(body.user?.avatarUrl).toBe("http://a.png");
  });

  it("updates display data when a GitHub login is renamed", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_t1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 4242, login: "octo", avatar_url: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", first);
    const firstLogin = await login(first);
    expect(firstLogin.callbackResponse.status).toBe(302);

    const second = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_t2" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 4242, login: "octo-renamed", avatar_url: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", second);
    const secondLogin = await login(second);

    const sessionCookie = cookieValue(secondLogin.callbackResponse, ctx.config.session.cookieName);
    const status = createSessionStatusFunction(ctx);
    const statusResponse = await status(
      new Request("http://localhost/api/auth/session", {
        headers: {
          cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie as string),
        },
      }),
    );
    const body = (await statusResponse.json()) as { user?: { login: string } };
    expect(body.user?.login).toBe("octo-renamed");

    const allUsers = await ctx.db.execute("SELECT github_id, github_login FROM users");
    expect(allUsers.rows).toHaveLength(1);
    expect(allUsers.rows[0]?.["github_id"]).toBe("4242");
    expect(allUsers.rows[0]?.["github_login"]).toBe("octo-renamed");
  });

  it("rejects missing identity fields without creating a user or session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_t3" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: "no-numeric-id" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { callbackResponse } = await login(fetchMock);
    expect(callbackResponse.status).toBe(502);
    expect(cookieValue(callbackResponse, ctx.config.session.cookieName)).toBeUndefined();

    const users = await ctx.db.execute("SELECT id FROM users");
    expect(users.rows).toHaveLength(0);
  });

  it("rejects mismatched state without creating a session", async () => {
    const start = createAuthStartFunction(ctx);
    const startResponse = await start(new Request("http://localhost/api/auth/github/start"));
    const oauthCookie = cookieValue(startResponse, OAUTH_COOKIE) as string;

    const callback = createAuthCallbackFunction(ctx);
    const response = await callback(
      new Request("http://localhost/api/auth/github/callback?code=x&state=WRONG", {
        headers: { cookie: cookieHeaderFrom(OAUTH_COOKIE, oauthCookie) },
      }),
    );
    expect(response.status).toBe(400);
    expect(cookieValue(response, ctx.config.session.cookieName)).toBeUndefined();
    expect(cookieValue(response, OAUTH_COOKIE)).toBe("");
  });

  it("rejects expired OAuth state", async () => {
    const short = await createTestContext(makeOptions({ session: { oauthCookieTtlMs: 50 } }));
    cleanup = short.cleanup;
    const shortCtx = short.ctx;

    const start = createAuthStartFunction(shortCtx);
    const startResponse = await start(new Request("http://localhost/api/auth/github/start"));
    const oauthCookie = cookieValue(startResponse, OAUTH_COOKIE) as string;

    await new Promise((resolve) => setTimeout(resolve, 120));

    const callback = createAuthCallbackFunction(shortCtx);
    const response = await callback(
      new Request("http://localhost/api/auth/github/callback?code=x&state=whatever", {
        headers: { cookie: cookieHeaderFrom(OAUTH_COOKIE, oauthCookie) },
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_callback");
  });

  it("enforces session expiry and logout revocation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_t4" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 777, login: "expiring", avatar_url: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { callbackResponse } = await login(fetchMock);
    const sessionCookie = cookieValue(callbackResponse, ctx.config.session.cookieName) as string;
    const status = createSessionStatusFunction(ctx);

    // Force expiry in storage.
    await ctx.db.execute("UPDATE sessions SET expires_at = 1");
    const expiredResponse = await status(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie) },
      }),
    );
    expect(((await expiredResponse.json()) as { authenticated: boolean }).authenticated).toBe(
      false,
    );
  });

  it("logout revokes the stored session, clears the cookie, and requires same-origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "gho_t5" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 999, login: "leaver", avatar_url: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { callbackResponse } = await login(fetchMock);
    const sessionCookie = cookieValue(callbackResponse, ctx.config.session.cookieName) as string;

    const logout = createLogoutFunction(ctx);

    // Cross-origin logout is rejected.
    const crossOrigin = await logout(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie),
        },
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const sameOrigin = await logout(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          origin: new URL(ctx.config.app.publicSiteUrl).origin,
          cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie),
        },
      }),
    );
    expect(sameOrigin.status).toBe(200);
    const setCookie = sameOrigin.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");

    const status = createSessionStatusFunction(ctx);
    const statusResponse = await status(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: cookieHeaderFrom(ctx.config.session.cookieName, sessionCookie) },
      }),
    );
    expect(((await statusResponse.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});
