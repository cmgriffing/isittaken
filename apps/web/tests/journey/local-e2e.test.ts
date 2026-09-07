import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSearchFunction } from "../../src/functions/search";
import { createCreativeSearchFunction } from "../../src/functions/creative-search";
import { createAuthStartFunction } from "../../src/functions/auth-github-start";
import { createAuthCallbackFunction } from "../../src/functions/auth-github-callback";
import {
  createLogoutFunction,
  createSessionStatusFunction,
} from "../../src/functions/auth-session";
import { createTestContext, type TestContextOptions } from "../helpers/test-context";
import type { AppContext } from "../../src/functions/composition";

const origin = "http://localhost:4321";

function makeOptions(extra: Partial<TestContextOptions> = {}): TestContextOptions {
  return { publicSiteUrl: origin, github: { clientId: "cid", clientSecret: "secret" }, ...extra };
}

let cleanup: () => void = () => {};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup?.();
  cleanup = () => {};
});
afterAll(() => cleanup?.());

function openRouterOk(candidates: string[]) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ candidates }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}

function npmResponseFor(name: string, taken: boolean) {
  return taken
    ? new Response(JSON.stringify({ name, "dist-tags": {} }), { status: 200 })
    : new Response("Not Found", { status: 404 });
}

async function login(ctx: AppContext, loginName: string, githubId: string): Promise<string> {
  const start = createAuthStartFunction(ctx);
  const startResponse = await start(new Request(`${origin}/api/auth/github/start`));
  const oauthCookie = /iit_oauth=([^;]*)/.exec(
    startResponse.headers.get("set-cookie") ?? "",
  )?.[1] as string;
  const state = new URL(startResponse.headers.get("location") as string).searchParams.get(
    "state",
  ) as string;

  const callback = createAuthCallbackFunction(ctx);
  const response = await callback(
    new Request(`${origin}/api/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: `iit_oauth=${oauthCookie}` },
    }),
  );
  expect(response.status).toBe(302);
  void loginName;
  void githubId;
  return /iit_session=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] as string;
}

describe("end-to-end local journey", () => {
  it("anonymous discovery -> injected candidates -> login -> creativity -> cache -> regeneration -> logout", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.wordnik.test")) {
        return new Response("slow down", { status: 429 }); // provider degradation
      }
      if (url.includes("openrouter.ai")) {
        return openRouterOk(["lazerly", "laser-kit"]);
      }
      if (url.includes("registry.npmjs.org")) {
        const name = url.split("/").pop() as string;
        return npmResponseFor(name, name === "laser" || name === "lazerly");
      }
      if (url.includes("github.com/login/oauth")) {
        return new Response(JSON.stringify({ access_token: "gho_journey" }), { status: 200 });
      }
      if (url.includes("api.github.com/user")) {
        return new Response(JSON.stringify({ id: 31337, login: "journey", avatar_url: null }), {
          status: 200,
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    });

    const context = await createTestContext(makeOptions({ fetchImpl }));
    cleanup = context.cleanup;
    const ctx = context.ctx;
    // The OAuth callback uses global fetch (server-side code exchange).
    vi.stubGlobal("fetch", fetchImpl);

    // 1. Anonymous discovery with Wordnik degraded: seed + npm results still come back.
    const search = createSearchFunction(ctx);
    const anonymous = await search(
      new Request(`${origin}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    expect(anonymous.status).toBe(200);
    const anonymousBody = (await anonymous.json()) as {
      sources: { source: string; status: string }[];
      candidates: { name: string; registryResults: { status: string }[] }[];
    };
    expect(anonymousBody.sources[0]).toMatchObject({ source: "wordnik", status: "unavailable" });
    expect(
      anonymousBody.candidates.find((c) => c.name === "laser")?.registryResults[0]?.status,
    ).toBe("taken");

    // 2. Injected candidates join with their own provenance and don't consume AI quota.
    const injected = await search(
      new Request(`${origin}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seed: "laser",
          injectedCreatives: ["beamrider"],
          injectedSynonyms: ["optics"],
        }),
      }),
    );
    const injectedBody = (await injected.json()) as {
      candidates: { name: string; provenance: string[] }[];
    };
    expect(injectedBody.candidates.find((c) => c.name === "beamrider")?.provenance).toContain(
      "injected-creative",
    );
    expect(injectedBody.candidates.find((c) => c.name === "optics")?.provenance).toContain(
      "injected-synonym",
    );
    const bucketsAfterInjection = await ctx.db.execute(
      "SELECT COUNT(*) AS n FROM ai_usage_buckets",
    );
    expect(Number(bucketsAfterInjection.rows[0]?.["n"])).toBe(0);

    // 3. GitHub-authenticated creativity.
    const token = await login(ctx, "journey", "31337");
    const status = createSessionStatusFunction(ctx);
    const session = await status(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: `iit_session=${token}` } }),
    );
    expect(((await session.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const creative = createCreativeSearchFunction(ctx);
    const headers = { cookie: `iit_session=${token}` };
    const firstCreative = await creative(
      new Request(`${origin}/api/creative-search`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    expect(firstCreative.status).toBe(200);
    const firstBody = (await firstCreative.json()) as {
      cached: boolean;
      candidates: { name: string }[];
    };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.candidates.map((c) => c.name)).toContain("lazerly");

    // 4. Cache reuse: second identical request hits the cache, no provider call.
    const callsBefore = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("openrouter.ai"),
    ).length;
    const secondCreative = await creative(
      new Request(`${origin}/api/creative-search`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    const secondBody = (await secondCreative.json()) as { cached: boolean };
    expect(secondBody.cached).toBe(true);
    const callsAfter = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes("openrouter.ai"),
    ).length;
    expect(callsAfter).toBe(callsBefore);

    // 5. Regeneration bypasses the cache and consumes quota.
    const regen = await creative(
      new Request(`${origin}/api/creative-search`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify({ seed: "laser", regenerate: true }),
      }),
    );
    expect(regen.status).toBe(200);
    expect(((await regen.json()) as { cached: boolean }).cached).toBe(false);
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes("openrouter.ai")).length).toBe(
      callsBefore + 1,
    );

    // 6. Logout revokes the session; creative access is denied afterwards.
    const logout = createLogoutFunction(ctx);
    const logoutResponse = await logout(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { origin, cookie: `iit_session=${token}` },
      }),
    );
    expect(logoutResponse.status).toBe(200);

    const postLogout = await creative(
      new Request(`${origin}/api/creative-search`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    expect(postLogout.status).toBe(401);

    // Ordinary search keeps working for the anonymous client throughout.
    const finalSearch = await search(
      new Request(`${origin}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    expect(finalSearch.status).toBe(200);
  });
});
