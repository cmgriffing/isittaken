import { afterAll, describe, expect, it, vi } from "vitest";
import { createCreativeSearchFunction } from "../../src/functions/creative-search";
import { createSearchFunction } from "../../src/functions/search";
import { createTestContext, type TestContextOptions } from "../helpers/test-context";
import type { AppContext } from "../../src/functions/composition";

const origin = "http://localhost:4321";

function makeOptions(extra: Partial<TestContextOptions> = {}): TestContextOptions {
  return { publicSiteUrl: origin, ...extra };
}

let ctx: AppContext;
let cleanup: () => void = () => {};

async function freshCtx(options: Partial<TestContextOptions> = {}): Promise<AppContext> {
  const context = await createTestContext(makeOptions(options));
  ctx = context.ctx;
  cleanup = context.cleanup;
  return context.ctx;
}

afterAll(() => {
  cleanup?.();
});

function post(
  handler: (r: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request(`${origin}/api/creative-search`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function openRouterOk(candidates: string[]) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ candidates }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );
}

function openRouterCalls(fetchImpl: { mock: { calls: unknown[][] } }): number {
  return fetchImpl.mock.calls.filter((call) => String(call[0]).includes("openrouter.ai")).length;
}

async function login(context: AppContext): Promise<string> {
  const token = `session-token-${Math.random().toString(36).slice(2)}`;
  const { sha256Hex } = await import("../../src/lib/crypto");
  const user = await context.users.upsertByGithubId(
    { githubId: "555", githubLogin: "creative", avatarUrl: null },
    context.clock.nowMs(),
  );
  await context.sessions.create({
    tokenHash: await sha256Hex(token),
    userId: user.id,
    createdAtMs: context.clock.nowMs(),
    expiresAtMs: context.clock.nowMs() + 3_600_000,
    lastSeenAtMs: context.clock.nowMs(),
  });
  return token;
}

describe("POST /api/creative-search", () => {
  it("denies anonymous callers before cache access or provider calls", async () => {
    const fetchImpl = vi.fn();
    const context = await freshCtx({ fetchImpl });
    const handler = createCreativeSearchFunction(context);

    const response = await post(handler, { seed: "laser" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("authentication_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    const context = await freshCtx();
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);
    const response = await handler(
      new Request(`${origin}/api/creative-search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          cookie: `${ctx.config.session.cookieName}=${token}`,
        },
        body: JSON.stringify({ seed: "laser" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("generates for authenticated users and settles quota without registry work", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toContain("openrouter.ai");
      return openRouterOk(["lazerly", "laser-kit", "Lazerly"]);
    });
    const context = await freshCtx({ fetchImpl });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);

    const response = await post(
      handler,
      { seed: "laser" },
      { cookie: `${ctx.config.session.cookieName}=${token}` },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      cached: boolean;
      candidates: { name: string; registryResults: unknown[] }[];
      quota: { burstRemaining: number; periodicRemaining: number };
    };
    expect(body.status).toBe("ok");
    expect(body.cached).toBe(false);
    const names = body.candidates.map((c) => c.name);
    expect(names).toContain("lazerly");
    expect(names).toContain("laser-kit");
    // "Lazerly" merged into "lazerly" by normalization: no duplicate name.
    expect(names.filter((n) => n === "lazerly")).toHaveLength(1);
    // Registry availability is the client's job; discovery returns none.
    for (const candidate of body.candidates) {
      expect(candidate.registryResults).toEqual([]);
    }
    expect(body.quota.periodicRemaining).toBeLessThan(ctx.config.quota.userPeriodicPerDay);

    const usage = await ctx.db.execute(
      "SELECT prompt_tokens, completion_tokens FROM ai_usage_buckets WHERE subject_type='application'",
    );
    expect(usage.rows).toHaveLength(1);
  });

  it("serves fresh cache hits without generation or quota consumption", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    fetchImpl.mockResolvedValueOnce(openRouterOk(["lazerly"]));
    const context = await freshCtx({ fetchImpl });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);
    const headers = { cookie: `${ctx.config.session.cookieName}=${token}` };

    expect((await post(handler, { seed: "laser" }, headers)).status).toBe(200);
    expect(openRouterCalls(fetchImpl)).toBe(1);

    fetchImpl.mockClear();
    const second = await post(handler, { seed: "laser" }, headers);
    expect(second.status).toBe(200);
    expect(openRouterCalls(fetchImpl)).toBe(0);
    const body = (await second.json()) as { cached: boolean; quota: { periodicRemaining: number } };
    expect(body.cached).toBe(true);
    // The earlier generation consumed one; the cache hit consumed none.
    expect(body.quota.periodicRemaining).toBe(ctx.config.quota.userPeriodicPerDay - 1);
  });

  it("regeneration bypasses the cache and consumes quota", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: string | URL | Request) =>
        String(url).includes("openrouter.ai")
          ? openRouterOk(["lazerly"])
          : new Response("Not Found", { status: 404 }),
      );
    const context = await freshCtx({ fetchImpl });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);
    const headers = { cookie: `${ctx.config.session.cookieName}=${token}` };

    expect((await post(handler, { seed: "laser" }, headers)).status).toBe(200);
    const regen = await post(handler, { seed: "laser", regenerate: true }, headers);
    expect(regen.status).toBe(200);
    expect(openRouterCalls(fetchImpl)).toBe(2);
    const body = (await regen.json()) as { cached: boolean };
    expect(body.cached).toBe(false);
  });

  it("reports generation failure without ever marking candidates available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const context = await freshCtx({ fetchImpl });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);

    const response = await post(
      handler,
      { seed: "laser" },
      { cookie: `${ctx.config.session.cookieName}=${token}` },
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("generation_failed");
  });

  it("enforces burst, periodic, and application ceilings atomically", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: string | URL | Request) =>
        String(url).includes("openrouter.ai")
          ? openRouterOk(["x1"])
          : new Response("Not Found", { status: 404 }),
      );
    const context = await freshCtx({
      fetchImpl,
      config: {
        quota: { userBurstPerMinute: 2, userPeriodicPerDay: 2, appDailyGenerations: 1000 },
      },
    });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);
    const headers = { cookie: `${ctx.config.session.cookieName}=${token}` };

    expect((await post(handler, { seed: "a" }, headers)).status).toBe(200);
    expect((await post(handler, { seed: "b" }, headers)).status).toBe(200);
    const denied = await post(handler, { seed: "c" }, headers);
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe("quota_exhausted");
    expect(denied.headers.get("x-quota-reset")).toBeTruthy();
  });

  it("exhausts the application-wide ceiling before calling OpenRouter", async () => {
    const fetchImpl = vi.fn();
    const context = await freshCtx({
      fetchImpl,
      config: { quota: { userBurstPerMinute: 5, userPeriodicPerDay: 25, appDailyGenerations: 1 } },
    });
    const handler = createCreativeSearchFunction(context);
    const token = await login(context);
    const headers = { cookie: `${ctx.config.session.cookieName}=${token}` };

    // Consume the single application slot directly.
    await context.quotas.reserve(
      { subjectType: "application", subjectId: "global" },
      "periodic-day",
      Math.floor(context.clock.nowMs() / 86_400_000) * 86_400_000,
      1,
      1,
    );

    const denied = await post(handler, { seed: "laser" }, headers);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("x-quota-scope")).toBe("application");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps ordinary search working when AI generation is failing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("AI down"));
    const context = await freshCtx({ fetchImpl });

    const searchHandler = createSearchFunction(context);
    const searchResponse = await searchHandler(
      new Request(`${origin}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: "laser", injectedCreatives: ["lazerly"] }),
      }),
    );
    expect(searchResponse.status).toBe(200);
    const body = (await searchResponse.json()) as {
      candidates: { name: string }[];
    };
    // Ordinary discovery is untouched by the provider failure.
    const names = body.candidates.map((c) => c.name);
    expect(names).toContain("laser");
    expect(names).toContain("lazerly");
  });
});
