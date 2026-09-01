// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { h } from "preact";
import SearchIsland, { Results } from "../../src/islands/SearchIsland";
import type { SearchResponse } from "../../src/domain/types";
import type { RegistryDescriptor } from "../../src/domain/registries";
import type { VerdictCell } from "../../src/lib/client/availability";
import { VERDICT_CACHE_STORAGE_KEY } from "../../src/lib/client/verdict-cache";
import { resetSearchStoreForTests } from "../../src/lib/client/search-store";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  resetSearchStoreForTests();
});

const seed = "laser";

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    seed,
    generatedAtMs: Date.now(),
    sources: [{ source: "wordnik", status: "ok" }],
    // Discovery returns candidates with provenance only; availability
    // results arrive progressively via the client fan-out.
    candidates: [
      { name: "laser", provenance: ["input"], registryResults: [] },
      { name: "optics", provenance: ["wordnik-synonym"], registryResults: [] },
    ],
    ...overrides,
  };
}

function typeSeedAndSubmit(value: string) {
  const input = screen.getByLabelText("Seed word") as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

/**
 * Fetch stub: /api/search and /api/creative-search return fixtures; the
 * check endpoint reports `available` for npm and `taken` for PyPI; browser
 * venue endpoints answer crates.io (taken) and NuGet (404).
 */
function stubMultiRegistryFetch(options: { search?: SearchResponse; session?: object } = {}) {
  return vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/auth/session")) {
      return new Response(JSON.stringify(options.session ?? { authenticated: false }), {
        status: 200,
      });
    }
    if (url.includes("/api/search")) {
      return new Response(JSON.stringify(options.search ?? searchResponse()), { status: 200 });
    }
    if (url.includes("/api/creative-search")) {
      return new Response(
        JSON.stringify({ error: { code: "authentication_required", message: "Sign in." } }),
        { status: 401 },
      );
    }
    if (url.includes("/api/check")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        registry?: string;
        word?: string;
      };
      const taken = body.registry === "pypi" || body.word === "optics";
      // Mirror the endpoint: the checked name is registry-normalized.
      const checkedName = (body.word ?? "").trim().replace(/\s+/g, "-").toLowerCase();
      return new Response(
        JSON.stringify({
          status: taken ? "taken" : "available",
          name: checkedName,
          checkedAtMs: Date.now(),
        }),
        { status: 200 },
      );
    }
    if (url.includes("crates.io/api/v1/crates/")) {
      return new Response(JSON.stringify({ crate: { name: "laser" } }), { status: 200 });
    }
    if (url.includes("api.nuget.org")) {
      return new Response("404", { status: 404 });
    }
    if (url.includes("packagist.org")) {
      return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
    }
    return new Response("unexpected upstream", { status: 500 });
  });
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

  it("fans out checks across selected registries and renders the progressive ratio", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());
    // Server-venue checks via /api/check (npm + pypi + rubygems + hex + maven)
    // and browser-venue checks via direct fetches (crates + nuget + packagist).
    await waitFor(() => {
      const apiCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/api/check"));
      expect(apiCalls.length).toBeGreaterThanOrEqual(8); // 2 candidates x 4+ server registries
    });

    // Ratio for "laser": available on npm, rubygems, hex, maven, nuget,
    // packagist; taken on pypi and crates -> 6/8.
    await waitFor(() => expect(screen.getAllByText("6/8").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/not a publishing guarantee/i).length).toBeGreaterThan(0);
  });

  it("does not check deselected registries and excludes them from the denominator", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));

    // Deselect all but npm before searching.
    for (const label of [
      "PyPI",
      "RubyGems",
      "Hex",
      "Maven Central",
      "crates.io",
      "NuGet",
      "Packagist",
    ]) {
      const checkbox = screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
      fireEvent.click(checkbox);
    }
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText("1/1").length).toBeGreaterThan(0));
    const apiCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/api/check"));
    const checkedRegistries = apiCalls.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body ?? "{}")) as { registry: string };
      return body.registry;
    });
    for (const registry of checkedRegistries) {
      expect(registry).toBe("npm");
    }
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("crates.io"))).toBe(false);
  });

  it("persists the registry selection across renders", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    const pypi = screen.getByLabelText(/^PyPI/) as HTMLInputElement;
    fireEvent.click(pypi);
    expect(JSON.parse(localStorage.getItem("iit_registry_selection") ?? "[]")).not.toContain(
      "pypi",
    );

    cleanup();
    render(h(SearchIsland, null));
    const pypiAfterReload = screen.getByLabelText(/^PyPI/) as HTMLInputElement;
    expect(pypiAfterReload.checked).toBe(false);
  });

  it("expands a candidate row into per-registry details with links and checked-as", async () => {
    const response = searchResponse({
      seed: "back end",
      candidates: [{ name: "back end", provenance: ["input"], registryResults: [] }],
    });
    const fetchImpl = stubMultiRegistryFetch({ search: response });
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit("back end"); // normalizes to back-end on most registries

    await waitFor(() => expect(screen.getByText("Names for “back end”")).toBeTruthy());
    await waitFor(() => {
      const apiCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/api/check"));
      expect(apiCalls.length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as Element);
    await waitFor(() => {
      expect(screen.getAllByText(/view on npm/)[0]).toBeTruthy();
    });
    const npmLink = screen.getAllByText(/view on npm/)[0]?.closest("a") as HTMLAnchorElement;
    expect(npmLink.getAttribute("href")).toBe("https://www.npmjs.com/package/back-end");
    // The row discloses the normalized name when it differs from the phrase.
    expect(screen.getAllByText("back-end").length).toBeGreaterThan(0);
  });

  it("labels stale cached verdicts until revalidation replaces them", async () => {
    // Pre-seed a stale npm verdict for "laser" (fresh TTL 5min elapsed, retention 7x not).
    const staleCheckedAt = Date.now() - 10 * 60_000;
    localStorage.setItem(
      VERDICT_CACHE_STORAGE_KEY,
      JSON.stringify({
        "npm:laser": {
          status: "available",
          checkedAtMs: staleCheckedAt,
          ttlMs: 300_000,
          lastUsedAtMs: staleCheckedAt,
        },
      }),
    );

    // Hold the revalidation gate closed so the stale paint is observable.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/check")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { registry?: string };
          if (body.registry === "npm") {
            await gate;
            return new Response(
              JSON.stringify({ status: "taken", name: "laser", checkedAtMs: Date.now() }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({ status: "unknown", name: "x", checkedAtMs: Date.now() }),
            { status: 200 },
          );
        }
        if (url.includes("/api/search")) {
          return new Response(JSON.stringify(searchResponse()), { status: 200 });
        }
        return new Response("slow down", { status: 429 });
      });
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    // The stale verdict paints immediately with a cached hint...
    await screen.findByText("cached");
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as Element);
    expect(screen.getAllByText("available").length).toBeGreaterThan(0);

    // ...and revalidation replaces it with the fresh verdict.
    release();
    await waitFor(() => expect(screen.queryByText("cached")).toBeNull());
    expect(screen.getAllByText("taken").length).toBeGreaterThan(0);
  });

  it("presents unknown results safely — never as available", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      if (url.includes("/api/check")) {
        return new Response(
          JSON.stringify({
            status: "unknown",
            name: "laser",
            checkedAtMs: Date.now(),
            reason: "npm registry rate limit exceeded.",
          }),
          { status: 200 },
        );
      }
      return new Response("slow down", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getAllByText("0/8").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0] as Element);
    await waitFor(() => {
      expect(screen.getAllByText(/unknown — try again/).length).toBeGreaterThan(0);
    });
  });

  it("keeps results usable and reports the failure when Wordnik is unavailable", async () => {
    const response = searchResponse({
      sources: [
        { source: "wordnik", status: "unavailable", reason: "Wordnik rate limit exceeded." },
      ],
    });
    vi.stubGlobal("fetch", stubMultiRegistryFetch({ search: response }));
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);

    await waitFor(() => expect(screen.getByText(/enrichment unavailable/i)).toBeTruthy());
    expect(screen.getByText("laser")).toBeTruthy();
  });

  it("offers sign-in for creative generation and preserves ordinary results", async () => {
    vi.stubGlobal("fetch", stubMultiRegistryFetch());
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());

    // Anonymous users see the explanation and sign-in instead of the button.
    expect(screen.queryByRole("button", { name: "Generate creative names" })).toBeNull();
    expect(await screen.findByText(/need a GitHub account/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.getByText("Names for “laser”")).toBeTruthy();
  });

  it("reports quota exhaustion with the server message", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.includes("/api/search")) {
        return new Response(JSON.stringify(searchResponse()), { status: 200 });
      }
      if (url.includes("/api/creative-search")) {
        return new Response(
          JSON.stringify({
            error: { code: "quota_exhausted", message: "Daily generation quota exhausted." },
          }),
          {
            status: 429,
            headers: {
              "x-quota-reset": String(Date.now() + 60_000),
              "x-quota-scope": "periodic",
            },
          },
        );
      }
      return new Response(JSON.stringify({ status: "available", checkedAtMs: Date.now() }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "Generate creative names" }));
    expect(await screen.findByText("Daily generation quota exhausted.")).toBeTruthy();
    expect(screen.getByText("Names for “laser”")).toBeTruthy();
  });
});

describe("agent-driven selection affordances", () => {
  it("hides the restore control while live selection matches saved", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Restore saved selection" })).toBeNull(),
    );
  });

  it("shows the restore control after an agent changes the selection and restores on click", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    typeSeedAndSubmit(seed);
    await waitFor(() => expect(screen.getByText("Names for “laser”")).toBeTruthy());

    // Agent replaces the selection through the shared store.
    const { getSearchStore } = await import("../../src/lib/client/search-store");
    getSearchStore().setAgentSelection(["hex"]);
    expect(await screen.findByRole("button", { name: "Restore saved selection" })).toBeTruthy();

    // Agent-touched chips carry the marker class. Hex is in both the saved
    // (all) and live selections, so the changed chips are the other seven.
    const untouchedChip = screen.getByLabelText(/^Hex/).closest("label") as HTMLLabelElement;
    expect(untouchedChip.className).not.toContain("agent-touched");
    const changedChip = screen.getByLabelText(/^PyPI/).closest("label") as HTMLLabelElement;
    expect(changedChip.className).toContain("agent-touched");

    // One click restores the saved selection.
    fireEvent.click(screen.getByRole("button", { name: "Restore saved selection" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Restore saved selection" })).toBeNull(),
    );
    expect((screen.getByLabelText(/^Hex/) as HTMLInputElement).checked).toBe(true);
  });

  it("agent selection is not persisted to localStorage", async () => {
    const fetchImpl = stubMultiRegistryFetch();
    vi.stubGlobal("fetch", fetchImpl);
    render(h(SearchIsland, null));
    const { getSearchStore } = await import("../../src/lib/client/search-store");
    // Establish a saved selection first (user toggle persists).
    fireEvent.click(screen.getByLabelText(/^PyPI/) as HTMLInputElement);
    expect(localStorage.getItem("iit_registry_selection")).not.toBeNull();
    const saved = localStorage.getItem("iit_registry_selection");
    // Agent replaces the live selection: the saved mirror must not change.
    getSearchStore().setAgentSelection(["maven"]);
    expect(localStorage.getItem("iit_registry_selection")).toBe(saved);
  });
});

describe("Results component (direct render)", () => {
  const now = Date.now();
  const cells = new Map<string, VerdictCell>();
  cells.set("laser|npm", {
    registry: "npm",
    candidateName: "laser",
    checkedName: "laser",
    status: "available",
    checkedAtMs: now,
  });
  cells.set("laser|pypi", {
    registry: "pypi",
    candidateName: "laser",
    checkedName: "laser",
    status: "taken",
    checkedAtMs: now,
  });

  function descriptorStubs() {
    return [
      { id: "npm", label: "npm", link: (n: string) => `https://www.npmjs.com/package/${n}` },
      { id: "pypi", label: "PyPI", link: (n: string) => `https://pypi.org/project/${n}/` },
    ] as unknown as RegistryDescriptor[];
  }

  it("is keyboard reachable with links and buttons", () => {
    const { container } = render(
      h(Results, {
        seedLabel: "laser",
        candidates: [{ name: "laser", provenance: ["input"], registryResults: [] }],
        cells,
        selectedDescriptors: descriptorStubs(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const link = container.querySelector(
      'a[href="https://www.npmjs.com/package/laser"]',
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("shows the ratio and taken link from the descriptor", () => {
    const { container } = render(
      h(Results, {
        seedLabel: "laser",
        candidates: [{ name: "laser", provenance: ["input"], registryResults: [] }],
        cells,
        selectedDescriptors: descriptorStubs(),
      }),
    );
    expect(container.querySelector(".ratio")?.textContent).toBe("1/2");
  });
});
