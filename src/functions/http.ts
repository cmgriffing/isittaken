/** Stable JSON error envelope shared by all API Functions. */
import { logger } from "../lib/logger";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function jsonResponse(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  headers: HeadersInit = {},
): Response {
  return jsonResponse({ error: { code, message } } satisfies ApiErrorBody, status, headers);
}

/** Extract the best-effort client identity for rate limiting. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-nf-client-connection-ip");
  if (forwarded) return forwarded;
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

/** Enforce a maximum request body size; returns null when within the cap. */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { ok: false, reason: "Content-Type must be application/json." };
  }
  const raw = await request.text();
  if (raw.length > maxBytes) {
    return { ok: false, reason: `Request body exceeds ${maxBytes} bytes.` };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "Request body is not valid JSON." };
  }
}

/**
 * Wrap a handler with a per-request correlation ID. The ID is echoed to the
 * client and attached to every log line the request produces, so upstream
 * failures, auth outcomes, and quota decisions can be traced together.
 * Logs are structured and secret-safe: handlers log identifiers and
 * outcomes, never API keys, tokens, or cookie values.
 */
export function withCorrelationId(
  handler: (request: Request, correlationId: string) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const correlationId =
      request.headers.get("x-correlation-id")?.slice(0, 64) ??
      `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const response = await handler(request, correlationId);
      response.headers.set("x-correlation-id", correlationId);
      return response;
    } catch (error) {
      logger.error("unhandled_error", {
        correlationId,
        path: new URL(request.url).pathname,
        reason: error instanceof Error ? error.message : String(error),
      });
      return errorResponse("internal", "Request failed unexpectedly.", 500, {
        "x-correlation-id": correlationId,
      });
    }
  };
}

/** Same-origin metadata check for cookie-authenticated mutating requests. */
export function isSameOriginRequest(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (origin) return origin === allowedOrigin;
  if (referer) {
    try {
      return new URL(referer).origin === allowedOrigin;
    } catch {
      return false;
    }
  }
  return false;
}
