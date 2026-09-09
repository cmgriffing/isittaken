import { describe, expect, it } from "vitest";
import { sanitizeUpstreamSnippet } from "../../../src/lib/upstream";

describe("sanitizeUpstreamSnippet", () => {
  it("collapses whitespace and newlines to a single line", () => {
    expect(sanitizeUpstreamSnippet("boom\n  detail\t here")).toBe("boom detail here");
  });

  it("redacts credential-looking values", () => {
    expect(sanitizeUpstreamSnippet("api_key=abc123 bad request")).toBe(
      "api_key=[redacted] bad request",
    );
    expect(sanitizeUpstreamSnippet("token: hunter2 rejected")).toBe("token: [redacted] rejected");
    expect(sanitizeUpstreamSnippet("access_token=xyz expired")).toBe(
      "access_token=[redacted] expired",
    );
  });

  it("truncates long bodies with an ellipsis", () => {
    const long = "x".repeat(600);
    const result = sanitizeUpstreamSnippet(long, 240);
    expect(result).toHaveLength(240);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves ordinary error text untouched", () => {
    expect(sanitizeUpstreamSnippet("invalid relationship type: nope")).toBe(
      "invalid relationship type: nope",
    );
  });
});
