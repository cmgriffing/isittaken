import { expect, test, type Page } from "@playwright/test";

/**
 * Browser tests run against the static build (`astro preview`) with the API
 * surface intercepted. This verifies hydration, keyboard operation,
 * progressive rendering, and static content routes without real upstreams.
 */

const searchFixture = {
  seed: "laser",
  generatedAtMs: Date.now(),
  sources: [{ source: "wordnik", status: "ok" }],
  candidates: [
    {
      name: "laser",
      provenance: ["input"],
      registryResults: [
        { registry: "npm", name: "laser", status: "available", checkedAtMs: Date.now() },
      ],
    },
    {
      name: "optics",
      provenance: ["wordnik-synonym"],
      registryResults: [
        { registry: "npm", name: "optics", status: "taken", checkedAtMs: Date.now() },
      ],
    },
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
      registryResults: [
        {
          registry: "npm",
          name: "laserly",
          status: "unknown",
          checkedAtMs: Date.now(),
          reason: "npm registry rate limit exceeded.",
        },
      ],
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
  test("keyboard operation: type a seed, press Enter, see results with statuses", async ({
    page,
  }) => {
    await mockApis(page);
    await page.goto("/");

    await page.getByLabel("Seed word").focus();
    await page.keyboard.type("laser");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Names for “laser”")).toBeVisible();
    await expect(page.locator(".status-available")).toHaveText("available");
    await expect(page.locator(".status-taken")).toHaveText("taken");
    await expect(page.getByText(/not a publishing guarantee/i)).toBeVisible();
    // npm remains the authority for taken names.
    await expect(page.getByRole("link", { name: "view on npm" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  test("progressive rendering: creative failure preserves ordinary results and shows unknown safely", async ({
    page,
  }) => {
    await mockApis(page, {
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

    await page.getByRole("button", { name: "Generate creative names" }).click();
    const signIn = page.getByRole("link", { name: "Sign in with GitHub" }).last();
    await expect(signIn).toBeVisible();
    // Ordinary results are untouched by the auth prompt.
    await expect(page.getByText("Names for “laser”")).toBeVisible();
  });

  test("quota messages surface when the ceiling is reached", async ({ page }) => {
    await mockApis(page, {
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
