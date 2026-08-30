// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { h } from "preact";
import SearchIsland, { Results } from "../../src/islands/SearchIsland";
import type { SearchResponse } from "../../src/domain/types";

afterEach(cleanup);

const seed = "laser";

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    seed,
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
    ...overrides,
  };
}

function typeSeedAndSubmit(value: string) {
  const input = screen.getByLabelText("Seed word") as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("SearchIsland", () => {
  it("shows a validation error for an empty seed without network calls", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit("   ");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders npm results with provenance and the publication disclaimer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(searchResponse()), { status: 200 })),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());
    const available = screen.getByText("available");
    expect(available.className).toContain("status-available");
    expect(screen.getByText("taken")).toBeTruthy();
    expect(screen.getByText("synonym")).toBeTruthy(); // provenance chip
    expect(screen.getByText(/not a publishing guarantee/i)).toBeTruthy();
    // Taken names link to npm as the authority.
    expect(screen.getByText("view on npm").getAttribute("href")).toBe(
      "https://www.npmjs.com/package/optics",
    );
  });

  it("keeps results usable and reports the failure when Wordnik is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            searchResponse({
              sources: [
                {
                  source: "wordnik",
                  status: "unavailable",
                  reason: "Wordnik rate limit exceeded.",
                },
              ],
            }),
          ),
          { status: 200 },
        ),
      ),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText(/enrichment unavailable/i)).toBeTruthy());
    expect(screen.getByText("laser")).toBeTruthy(); // seed result still present
  });

  it("presents unknown results safely — never as available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            searchResponse({
              candidates: [
                {
                  name: "ghost",
                  provenance: ["input"],
                  registryResults: [
                    {
                      registry: "npm",
                      name: "ghost",
                      status: "unknown",
                      checkedAtMs: Date.now(),
                      reason: "npm registry rate limit exceeded.",
                    },
                  ],
                },
              ],
            }),
          ),
          { status: 200 },
        ),
      ),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText("unknown — try again")).toBeTruthy());
    expect(screen.queryByText("available")).toBeNull();
  });

  it("offers sign-in for creative generation and preserves ordinary results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/search")) {
          return new Response(JSON.stringify(searchResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify({ error: { code: "authentication_required", message: "Sign in." } }),
          { status: 401 },
        );
      }),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Generate creative names" }));
    const signIn = await screen.findByText("Creative generation needs an account.");
    expect(signIn).toBeTruthy();
    // Ordinary results are untouched.
    expect(screen.getByText("Names for “laser”")).toBeTruthy();
  });

  it("shows quota feedback and merges creative results by normalized name", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/search")) {
          return new Response(JSON.stringify(searchResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            status: "ok",
            cached: false,
            seed,
            generatedAtMs: Date.now(),
            quota: { burstRemaining: 4, periodicRemaining: 24, resetsAtMs: Date.now() + 60_000 },
            candidates: [
              {
                name: "laser", // same normalized name as ordinary "laser"
                provenance: ["openrouter"],
                registryResults: [
                  { registry: "npm", status: "taken", checkedAtMs: Date.now() + 1_000 },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Generate creative names" }));
    await waitFor(() => expect(screen.getByText(/Quota remaining/)).toBeTruthy());

    // The merged list must contain one "laser" row with both provenance labels.
    const rows = screen.getAllByText("laser");
    expect(rows.length).toBe(1);
    expect(screen.getByText("AI idea")).toBeTruthy();
    expect(screen.getByText("your word")).toBeTruthy();
  });

  it("reports quota exhaustion with the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/search")) {
          return new Response(JSON.stringify(searchResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            error: { code: "quota_exhausted", message: "Daily generation quota exhausted." },
          }),
          {
            status: 429,
            headers: { "x-quota-reset": String(Date.now() + 60_000), "x-quota-scope": "periodic" },
          },
        );
      }),
    );
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Generate creative names" }));
    expect(await screen.findByText("Daily generation quota exhausted.")).toBeTruthy();
    expect(screen.getByText("Names for “laser”")).toBeTruthy();
  });
});

describe("Results component (direct render)", () => {
  it("is keyboard reachable with links and buttons", () => {
    const { container } = render(
      h(Results, {
        seedLabel: "laser",
        candidates: searchResponse().candidates,
        ordinarySources: [{ source: "wordnik", status: "ok" }],
      }),
    );
    const link = container.querySelector(
      'a[href="https://www.npmjs.com/package/optics"]',
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("links multi-word candidates by their npm slug, not the phrase", () => {
    const { container } = render(
      h(Results, {
        seedLabel: "back",
        candidates: [
          {
            name: "back end", // domain form keeps the phrase
            provenance: ["wordnik-synonym"],
            registryResults: [
              { registry: "npm", name: "back-end", status: "taken", checkedAtMs: Date.now() },
            ],
          },
        ],
        ordinarySources: [],
      }),
    );
    // The npm link must target the slug npm actually checked.
    const link = container.querySelector(
      'a[href="https://www.npmjs.com/package/back-end"]',
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    // And the row discloses the slug when it differs from the phrase.
    expect(container.textContent).toContain("checked as back-end on npm");
  });
});
