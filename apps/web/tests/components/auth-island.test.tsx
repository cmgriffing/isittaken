// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { h } from "preact";
import AuthIsland from "../../src/islands/AuthIsland";

afterEach(cleanup);

describe("AuthIsland", () => {
  it("shows the generic login state for anonymous visitors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ authenticated: false }), { status: 200 })),
    );
    render(h(AuthIsland, null));
    const link = await screen.findByText("Sign in with GitHub");
    expect(link.getAttribute("href")).toBe("/api/auth/github/start");
  });

  it("replaces the login state with the GitHub identity for a valid session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ authenticated: true, user: { login: "octo", avatarUrl: null } }),
            { status: 200 },
          ),
        ),
    );
    render(h(AuthIsland, null));
    await waitFor(() => expect(screen.getByText("octo")).toBeTruthy());
    expect(screen.queryByText("Sign in with GitHub")).toBeNull();
  });

  it("logs out, clearing the session state", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(
          JSON.stringify({ authenticated: true, user: { login: "octo", avatarUrl: null } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(h(AuthIsland, null));
    await waitFor(() => expect(screen.getByText("octo")).toBeTruthy());

    fireEvent.click(screen.getByText("Log out"));
    await waitFor(() => expect(screen.getByText("Sign in with GitHub")).toBeTruthy());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const logoutCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(logoutCall[0]).toBe("/api/auth/logout");
    expect(logoutCall[1].method).toBe("POST");
  });

  it("degrades gracefully when the session endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(h(AuthIsland, null));
    await screen.findByText("Sign in with GitHub");
  });
});
