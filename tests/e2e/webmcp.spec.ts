import { expect, test, type Page } from "@playwright/test";

/**
 * WebMCP e2e: a `page.addInitScript` shim installs a fake draft-API
 * (`document.modelContext.registerTool`) BEFORE app scripts run. Verifies:
 * registration on the home page, tool execute round-trips, and no
 * registration on a non-home page.
 */

async function installModelContextShim(page: Page, options: { apiRoutes?: boolean } = {}) {
  await page.addInitScript(() => {
    const registry = new Map<
      string,
      (input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => unknown
    >();
    const listeners = new Map<string, EventListener>();
    const target = new EventTarget();
    (window as unknown as { __webmcpTools: typeof registry }).__webmcpTools = registry;
    (window as unknown as { __webmcpProgress: number }).__webmcpProgress = 0;
    const modelContext = Object.assign(target, {
      registerTool: (tool: {
        name: string;
        execute: (input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => unknown;
      }) => {
        registry.set(tool.name, tool.execute);
        return undefined;
      },
      addEventListener: (type: string, listener: EventListener) => {
        target.addEventListener(type, listener);
        listeners.set(type, listener);
      },
    });
    Object.defineProperty(document, "modelContext", {
      value: modelContext,
      configurable: true,
    });
    void listeners;
  });
  if (options.apiRoutes) {
    await mockApiRoutes(page);
  }
}

async function mockApiRoutes(page: Page) {
  await page.route("**/api/search", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        seed: "laser",
        generatedAtMs: Date.now(),
        sources: [{ source: "wordnik", status: "ok" }],
        candidates: [{ name: "laser", provenance: ["input"], registryResults: [] }],
      }),
    }),
  );
  await page.route("**/api/check", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "available", name: "laser", checkedAtMs: Date.now() }),
    }),
  );
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

async function registeredToolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as { __webmcpTools: Map<string, unknown> }).__webmcpTools.keys(),
  ]);
}

test.describe("webmcp tools", () => {
  test("registers exactly the four tools on the home page", async ({ page }) => {
    await installModelContextShim(page);
    await page.goto("/");
    await expect
      .poll(() => registeredToolNames(page), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          "list_registries",
          "search_names",
          "check_availability",
          "batch_check_availability",
        ]),
      );
    const names = await registeredToolNames(page);
    expect(names).toHaveLength(4);
  });

  test("list_registries round-trips the descriptor lineup", async ({ page }) => {
    await installModelContextShim(page);
    await page.goto("/");
    await expect
      .poll(() => registeredToolNames(page), { timeout: 10_000 })
      .toContain("list_registries");
    const result = await page.evaluate(async () => {
      const tools = (
        window as unknown as {
          __webmcpTools: Map<string, (input?: Record<string, unknown>) => unknown>;
        }
      ).__webmcpTools;
      const result = (await tools.get("list_registries")?.({})) as {
        registries: { id: string }[];
      };
      return result?.registries.map((r) => r.id);
    });
    expect(result).toEqual([
      "npm",
      "pypi",
      "rubygems",
      "hex",
      "maven",
      "crates",
      "nuget",
      "packagist",
    ]);
  });

  test("batch_check_availability paints the grid and resolves the verdict table", async ({
    page,
  }) => {
    await installModelContextShim(page, { apiRoutes: true });
    await page.goto("/");
    await expect
      .poll(() => registeredToolNames(page), { timeout: 10_000 })
      .toContain("batch_check_availability");

    const result = await page.evaluate(async () => {
      const tools = (
        window as unknown as {
          __webmcpTools: Map<
            string,
            (input?: Record<string, unknown>) => Promise<Record<string, unknown>>
          >;
        }
      ).__webmcpTools;
      return (await tools.get("batch_check_availability")?.({
        seed: "laser",
        registries: ["npm", "pypi"],
      })) as {
        verdicts: { candidate: string; registry: string; status: string }[];
        selectionUsed: string[];
      };
    });

    expect(result.selectionUsed).toEqual(["npm", "pypi"]);
    expect(result.verdicts.length).toBeGreaterThanOrEqual(2);
    // The grid painted live: the candidate row is visible with results.
    await expect(page.getByText("Names for “laser”")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/not a publishing guarantee/i)).toBeVisible();
    await expect(page.locator('code.name:has-text("laser")')).toBeVisible();
  });

  test("does not register tools on a non-home page", async ({ page }) => {
    await installModelContextShim(page);
    await page.goto("/docs/about");
    await page.waitForTimeout(500);
    expect(await registeredToolNames(page)).toHaveLength(0);
  });

  test("concurrent batch is refused with batch_in_progress, and restore works (5.2 harness pass)", async ({
    page,
  }) => {
    await installModelContextShim(page, { apiRoutes: true });
    // Hold /api/check until released so the first batch stays in flight.
    await page.route("**/api/check", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "available", name: "laser", checkedAtMs: Date.now() }),
      });
    });
    await page.goto("/");
    await expect
      .poll(() => registeredToolNames(page), { timeout: 10_000 })
      .toContain("batch_check_availability");

    const outcome = await page.evaluate(async () => {
      const tools = (
        window as unknown as {
          __webmcpTools: Map<string, (input?: Record<string, unknown>) => Promise<unknown>>;
        }
      ).__webmcpTools;
      const batch = tools.get("batch_check_availability");
      const first = batch?.({ seed: "laser", registries: ["pypi"] }) as Promise<unknown>;
      const second = (await batch?.({ seed: "laser" })) as { error: { code: string } };
      await first;
      return second;
    });
    expect(outcome.error.code).toBe("batch_in_progress");

    // Agent selection replaced the toggles and flagged restore affordance.
    await expect(page.getByRole("button", { name: "Restore saved selection" })).toBeVisible();
    await page.getByRole("button", { name: "Restore saved selection" }).click();
    await expect(page.getByRole("button", { name: "Restore saved selection" })).toBeHidden();
  });
});
