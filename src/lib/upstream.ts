import { logger } from "./logger";

/**
 * Read a bounded, secret-safe snippet from an upstream error response for
 * logging and operator-facing reasons. Query credentials are redacted, and
 * whitespace is collapsed so the snippet is single-line.
 */
export async function readUpstreamErrorSnippet(
  response: Response,
  maxChars = 240,
): Promise<string> {
  try {
    const text = await response.text();
    return sanitizeUpstreamSnippet(text, maxChars);
  } catch {
    return "";
  }
}

export function sanitizeUpstreamSnippet(text: string, maxChars = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const redacted = collapsed.replace(
    /((?:api_?key|access_?token|token|secret|password|client_?id)["'=:\s]+)[^\s&"']+/gi,
    "$1[redacted]",
  );
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Log an upstream failure with its (sanitized) response body for diagnosis. */
export function logUpstreamError(
  provider: string,
  status: number,
  snippet: string,
  extra: Record<string, unknown> = {},
): void {
  logger.warn("upstream_error", {
    provider,
    status,
    body: snippet || "(no body)",
    ...extra,
  });
}
