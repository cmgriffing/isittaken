import { z } from "zod";
import type { AppContext } from "./composition";
import { registryDescriptor } from "./composition";
import { clientIp, errorResponse, jsonResponse, readJsonBody, withCorrelationId } from "./http";
import { logger } from "../lib/logger";

const MAX_BODY_BYTES = 2_048;

/**
 * Public single-registry availability check endpoint.
 *
 * `POST /api/check { word, registry }` returns one verdict for one
 * registry-normalized name. Each accepted request performs at most one
 * upstream registry lookup (or none: a fresh cache hit or a locally
 * classified invalid name). Browser-venue registries refuse the server path
 * so their CORS-enabled endpoints serve visitor traffic directly.
 */
export function createCheckFunction(ctx: AppContext): (request: Request) => Promise<Response> {
  const bodySchema = z.object({
    word: z.string(),
    registry: z.string(),
  });

  return withCorrelationId(async (request, correlationId): Promise<Response> => {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Use POST.", 405, { allow: "POST" });
    }

    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return errorResponse("invalid_request", body.reason, 400);
    }

    const parsed = bodySchema.safeParse(body.body);
    if (!parsed.success) {
      return errorResponse("invalid_request", "Check request shape is invalid.", 400);
    }

    const descriptor = registryDescriptor(parsed.data.registry);
    if (!descriptor) {
      return errorResponse(
        "unknown_registry",
        `Unsupported registry: ${parsed.data.registry}.`,
        400,
      );
    }

    if (descriptor.venue === "browser") {
      return errorResponse(
        "browser_venue_registry",
        `${descriptor.label} checks run in the browser against its public endpoint; this API does not proxy it.`,
        400,
      );
    }

    if (parsed.data.word.trim().length === 0) {
      return errorResponse("invalid_word", "Word must be non-empty.", 400);
    }

    const registry = ctx.serverRegistries.get(descriptor.id);
    if (!registry) {
      logger.error("check_registry_unavailable", { correlationId, registry: descriptor.id });
      return errorResponse("internal", "Registry adapter unavailable.", 500);
    }

    // Validate locally first: invalid names are classified without touching
    // the network or consuming the per-IP rate-limit budget.
    const validation = registry.validate(parsed.data.word);
    if (!validation.ok) {
      return jsonResponse(
        {
          status: "invalid",
          name: parsed.data.word.trim(),
          checkedAtMs: ctx.clock.nowMs(),
          reason: validation.reason,
        },
        200,
      );
    }

    const ip = clientIp(request);
    const limiter = ctx.registryRateLimiters.get(descriptor.id);
    if (limiter) {
      const retryAfter = limiter.check(`${descriptor.id}:${ip}`, ctx.clock.nowMs());
      if (retryAfter !== null) {
        logger.warn("check_rate_limited", { correlationId, ip, registry: descriptor.id });
        return errorResponse(
          "rate_limited",
          `Too many ${descriptor.label} checks; retry later.`,
          429,
          { "retry-after": String(retryAfter) },
        );
      }
    }

    try {
      const result = await registry.lookup(validation.name);
      return jsonResponse(
        {
          status: result.status,
          name: validation.name,
          checkedAtMs: result.checkedAtMs,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        200,
      );
    } catch (error) {
      logger.error("check_failed", {
        correlationId,
        registry: descriptor.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return errorResponse("internal", "Check failed unexpectedly.", 500);
    }
  });
}
