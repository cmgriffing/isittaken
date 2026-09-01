import { z } from "zod";
import { runDiscovery } from "../domain/run-discovery";
import { SearchValidationError } from "../domain/errors";
import { validateSearchRequest } from "../domain/validate-search-request";
import type { DiscoveryDeps } from "../domain/run-discovery";
import type { AppContext } from "./composition";
import { clientIp, errorResponse, jsonResponse, readJsonBody, withCorrelationId } from "./http";
import { logger } from "../lib/logger";

const MAX_BODY_BYTES = 16_384;

/**
 * Public candidate-discovery endpoint. Returns the seed, per-source
 * outcomes, and composed candidates with provenance — no registry work.
 * Availability checks happen per-registry via `POST /api/check` (server
 * venue) or direct browser fetches (browser venue).
 */
export function createSearchFunction(ctx: AppContext): (request: Request) => Promise<Response> {
  const bodySchema = z.object({
    seed: z.string(),
    injectedSynonyms: z.array(z.string()).optional(),
    injectedCreatives: z.array(z.string()).optional(),
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
      return errorResponse("invalid_request", "Search request shape is invalid.", 400);
    }

    const { limits } = ctx.config;
    let validated;
    try {
      validated = validateSearchRequest(
        {
          seed: parsed.data.seed,
          injectedSynonyms: parsed.data.injectedSynonyms,
          injectedCreatives: parsed.data.injectedCreatives,
        },
        limits,
      );
    } catch (error) {
      if (error instanceof SearchValidationError) {
        return errorResponse(error.code, error.message, 400);
      }
      throw error;
    }

    const ip = clientIp(request);
    const retryAfter = ctx.searchRateLimiter.check(ip, ctx.clock.nowMs());
    if (retryAfter !== null) {
      logger.warn("search_rate_limited", { correlationId, ip });
      return errorResponse("rate_limited", "Too many search requests.", 429, {
        "retry-after": String(retryAfter),
      });
    }

    const deps: DiscoveryDeps = {
      sources: [ctx.wordnikSource],
      clock: ctx.clock,
      limits,
    };

    try {
      const response = await runDiscovery(validated, deps);
      const degraded = response.sources
        .filter((source) => source.status !== "ok")
        .map((source) => ({
          source: source.source,
          status: source.status,
          reason: source.reason,
        }));
      if (degraded.length > 0) {
        logger.info("search_degraded_sources", { correlationId, sources: degraded });
      }
      return jsonResponse(response, 200);
    } catch (error) {
      logger.error("search_failed", {
        correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return errorResponse("internal", "Search failed unexpectedly.", 500);
    }
  });
}
