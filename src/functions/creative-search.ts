import { runCreativeSearch } from "../domain/run-creative-search";
import type { AppContext } from "./composition";
import {
  errorResponse,
  isSameOriginRequest,
  jsonResponse,
  readJsonBody,
  withCorrelationId,
} from "./http";
import { resolveSession } from "./auth-session";
import { SearchValidationError } from "../domain/errors";
import { validateSearchRequest } from "../domain/validate-search-request";
import { logger } from "../lib/logger";

const MAX_BODY_BYTES = 4_096;

/**
 * Authenticated creative-search endpoint. Same-origin + rate-limited;
 * authentication precedes any cache access; quota/reset metadata is
 * returned alongside results. Ordinary search remains untouched by any
 * AI failure.
 */
export function createCreativeSearchFunction(
  ctx: AppContext,
): (request: Request) => Promise<Response> {
  return withCorrelationId(async (request, correlationId): Promise<Response> => {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Use POST.", 405, { allow: "POST" });
    }

    // Cookie-authenticated, cost-incurring POST: same-origin enforcement.
    if (!isSameOriginRequest(request, new URL(ctx.config.app.publicSiteUrl).origin)) {
      return errorResponse(
        "cross_origin_forbidden",
        "Creative search requires a same-origin request.",
        403,
      );
    }

    const resolved = await resolveSession(ctx, request);
    if (!resolved || !resolved.user) {
      return errorResponse(
        "authentication_required",
        "Sign in with GitHub to use creative generation.",
        401,
      );
    }

    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (!body.ok) {
      return errorResponse("invalid_request", body.reason, 400);
    }

    const raw = body.body as { seed?: unknown; regenerate?: unknown };
    let validated;
    try {
      validated = validateSearchRequest(
        { seed: typeof raw.seed === "string" ? raw.seed : "" },
        ctx.config.limits,
      );
    } catch (error) {
      if (error instanceof SearchValidationError) {
        return errorResponse(error.code, error.message, 400);
      }
      throw error;
    }
    const regenerate = raw.regenerate === true;

    const userId = resolved.user.id;
    const retryAfter = ctx.creativeRateLimiter.check(userId, ctx.clock.nowMs());
    if (retryAfter !== null) {
      logger.warn("creative_rate_limited", { correlationId, userId });
      return errorResponse("rate_limited", "Too many creative requests.", 429, {
        "retry-after": String(retryAfter),
      });
    }

    try {
      const result = await runCreativeSearch(
        { seed: validated.seed, regenerate },
        {
          provider: ctx.openRouterProvider,
          registries: [ctx.npmRegistry],
          quotas: ctx.quotas,
          clock: ctx.clock,
          userId,
          limits: ctx.config.limits,
          registryConcurrency: ctx.config.npm.concurrency,
          quota: ctx.config.quota,
          creative: {
            model: ctx.config.openrouter.model,
            promptVersion: ctx.config.openrouter.promptVersion,
            schemaVersion: ctx.config.openrouter.schemaVersion,
            maxCandidates: ctx.config.openrouter.maxCandidates,
          },
          cache: ctx.cache,
          cachePolicy: {
            freshForMs: ctx.config.cache.ttl.openrouterMs,
            retainForMs: ctx.config.cache.ttl.openrouterMs * 4,
          },
        },
      );

      if (result.status === "ok") {
        logger.info("creative_generation_completed", {
          correlationId,
          userId,
          cached: result.cached,
          candidateCount: result.candidates.length,
        });
        return jsonResponse(result, 200);
      }
      if (result.status === "quota_exhausted") {
        logger.info("creative_quota_denied", { correlationId, userId, scope: result.scope });
        return errorResponse("quota_exhausted", result.message, 429, {
          "retry-after": String(
            Math.max(1, Math.ceil((result.resetsAtMs - ctx.clock.nowMs()) / 1_000)),
          ),
          "x-quota-scope": result.scope,
          "x-quota-reset": String(result.resetsAtMs),
        });
      }
      logger.warn("creative_generation_failed", { correlationId, userId, reason: result.reason });
      return errorResponse("generation_failed", result.reason, 502, {
        "x-quota-reset": String(result.quota.resetsAtMs),
      });
    } catch (error) {
      logger.error("creative_search_failed", {
        correlationId,
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return errorResponse("internal", "Creative search failed unexpectedly.", 500);
    }
  });
}
