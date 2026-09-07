// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";
import { h } from "preact";

afterEach(cleanup);

describe("component rendering", () => {
  it("renders a Preact island-style component", () => {
    render(h("p", { "data-testid": "smoke" }, "search shell"));
    const node = screen.getByTestId("smoke");
    expect(node.textContent).toBe("search shell");
  });
});
