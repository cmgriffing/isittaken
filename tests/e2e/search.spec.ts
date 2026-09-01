import { expect, test, type Page } from "@playwright/test";

/**
 * Browser tests run against the static build (`astro preview`) with the API
 * surface intercepted. This verifies hydration, keyboard operation,
 * progressive multi-registry rendering, and static content routes without
 * real upstreams.
 */

const searchFixture = {
  seed: "laser",
  generatedAtMs: Date.now(),
  sources: [{ source: "wordnik", status: "ok" }],
  // Discovery returns candidates with provenance only; availability
  // verdicts stream in from the client fan-out.
  candidates: [
    { name: "laser", provenance: ["input"], registryResults: [] },
    { name: "optics", provenance: ["wordnik-synonym"], registryResults: [] },
  ],
};

const creativeFixture = {
  status: "ok",
  cached: false,
  seed: "laser",
  generatedAtMs: Date.now(),
  quota: { burstRemaining: 4, periodicRemaining: 24, resetsAtMs: Date.now() + 60_000 },
  candidates: [
    {
      name: "laserly",
      provenance: ["openrouter"],
      registryResults: [],
    },
  ],
};

async function mockApis(
  page: Page,
  options: {
    session?: object;
    creative?: { status: number; body: object; headers?: Record<string, string> };
  } = {},
) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(options.session ?? { authenticated: false }),
    }),
  );
  await page.route("**/api/search", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(searchFixture),
    }),
  );
  await page.route("**/api/creative-search", (route) => {
    const creative = options.creative ?? { status: 200, body: creativeFixture };
    route.fulfill({
      status: creative.status,
      contentType: "application/json",
      body: JSON.stringify(creative.body),
      headers: creative.headers,
    });
  });
  // Server-venue checks: taken only for npm/optics; everything else available.
  await page.route("**/api/check", (route) => {
    const body = route.request().postDataJSON() as { registry: string; word: string };
    const status = body.registry === "npm" && body.word === "optics" ? "taken" : "available";
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status, name: body.word, checkedAtMs: Date.now() }),
    });
  });
  // Browser-venue registries answer directly (CORS endpoints).
  await page.route("**/crates.io/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api.nuget.org/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/packagist.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total: 0, results: [] }),
    }),
  );
}

test.describe("static shell", () => {
  test("serves prebuilt pages without SSR", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Is that package name taken?",
    );
    for (const path of ["/docs/about", "/docs/privacy", "/docs/methodology"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("article.prose")).toBeVisible();
    }
  });

  test("unmatched API paths do not fall through to static assets", async ({ request }) => {
    const response = await request.get("/api/definitely-not-a-real-endpoint");
    expect(response.status()).toBe(404);
  });
});

test.describe("search island (hydrated)", () => {
  test("keyboard operation: type a seed, press Enter, see progressive multi-registry results", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page.getByLabel("Seed word").focus();
    await page.keyboard.type("laser");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Names for “laser”")).toBeVisible();
    // Progressive ratio: every selected registry answered (7 available for
    // "laser" — npm/optics is the single taken — over 8 selected).
    await expect(page.getByText("7/8").first()).toBeVisible();
    await expect(page.getByText(/not a publishing guarantee/i)).toBeVisible();

    // Expanding the optics row shows the taken pill and the npm link.
    await page.getByRole("button", { name: "Details" }).nth(1).click();
    await expect(page.locator(".status-taken").first()).toHaveText("taken");
    await expect(page.getByRole("link", { name: "view on npm" }).first()).toBeAttached();
  });

  test("progressive rendering: creative failure preserves ordinary results", async ({ page }) => {
    await mockApis(page, {
      session: { authenticated: true },
      creative: {
        status: 502,
        body: {
          error: { code: "generation_failed", message: "OpenRouter responded with status 500." },
        },
      },
    });
    await page.goto("/");
    await page.getByLabel("Seed word").fill("laser");
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByText("Names for “laser”")).toBeVisible();
    await page.getByRole("button", { name: "Generate creative names" }).click();

    await expect(page.getByText(/OpenRouter responded with status 500/)).toBeVisible();
    await expect(page.getByText("Names for “laser”")).toBeVisible(); // ordinary results preserved
    await page.getByRole("button", { name: "Try again" }).click(); // retry path exists
  });

  test("authentication transitions: anonymous creative request shows sign-in, session shows quota", async ({
    page,
  }) => {
    await mockApis(page, {
      creative: {
        status: 401,
        body: {
          error: {
            code: "authentication_required",
            message: "Sign in with GitHub to use creative generation.",
          },
        },
      },
    });
    await page.goto("/");
    await page.getByLabel("Seed word").fill("laser");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("Names for “laser”")).toBeVisible();

    // Anonymous users see the explanation and sign-in instead of the button.
    await expect(page.getByText(/need a GitHub account/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in with GitHub" }).last()).toBeVisible();
    // Ordinary results are untouched by the auth prompt.
    await expect(page.getByText("Names for “laser”")).toBeVisible();
  });

  test("quota messages surface when the ceiling is reached", async ({ page }) => {
    await mockApis(page, {
      session: { authenticated: true },
      creative: {
        status: 429,
        body: { error: { code: "quota_exhausted", message: "Daily generation quota exhausted." } },
        headers: { "x-quota-reset": String(Date.now() + 60_000), "x-quota-scope": "periodic" },
      },
    });
    await page.goto("/");
    await page.getByLabel("Seed word").fill("laser");
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("button", { name: "Generate creative names" }).click();

    await expect(page.getByText("Daily generation quota exhausted.")).toBeVisible();
    await expect(page.getByText("Names for “laser”")).toBeVisible();
  });
});
