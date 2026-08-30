import type { CreativeProvider, CreativeProviderResult } from "../../domain/ports";

export const OPENROUTER_PROMPT_VERSION = 1;

/**
 * Strict JSON Schema for model output. The schema version participates in
 * the cache key so a schema change invalidates old cached generations.
 */
export const CREATIVE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: { message?: unknown };
}

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  promptVersion: number;
  timeoutMs: number;
  maxCandidates: number;
  fetchImpl?: typeof fetch;
}

function buildMessages(seed: string, count: number) {
  return [
    {
      role: "system" as const,
      content:
        `You invent short, memorable, publishable unscoped npm package names. ` +
        `Reply with JSON only, matching the required schema. ` +
        `Prompt version ${OPENROUTER_PROMPT_VERSION}.`,
    },
    {
      role: "user" as const,
      content:
        `Seed word: "${seed}". Propose ${count} package-name candidates ` +
        `inspired by the seed. Lowercase letters, digits, hyphens, dots or ` +
        `underscores; no spaces; no scope prefixes.`,
    },
  ];
}

/**
 * OpenRouter adapter. Requests strict JSON Schema output, validates the
 * response, bounds the candidate list, and extracts usage metadata for
 * quota settlement. Malformed output maps to a non-refundable failure
 * (model work was consumed); transport/HTTP failures are refundable.
 */
export function createOpenRouterProvider(options: OpenRouterOptions): CreativeProvider {
  const { apiKey, baseUrl, model, timeoutMs, maxCandidates } = options;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    id: "openrouter",
    async generate(seed: string, count: number): Promise<CreativeProviderResult> {
      if (!apiKey) {
        return {
          status: "failed",
          reason: "OPENROUTER_API_KEY is not configured.",
          refundable: true,
        };
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: buildMessages(seed, Math.min(count, maxCandidates)),
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "creative_candidates",
                strict: true,
                schema: CREATIVE_SCHEMA,
              },
            },
          }),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        return {
          status: "failed",
          reason: timedOut ? "OpenRouter request timed out." : "OpenRouter request failed.",
          refundable: true,
        };
      }

      if (response.status === 429) {
        return { status: "failed", reason: "OpenRouter rate limit exceeded.", refundable: true };
      }
      if (!response.ok) {
        return {
          status: "failed",
          reason: `OpenRouter responded with status ${response.status}.`,
          refundable: true,
        };
      }

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch {
        return {
          status: "failed",
          reason: "OpenRouter returned a non-JSON response.",
          refundable: false,
        };
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return {
          status: "failed",
          reason: "OpenRouter response did not include message content.",
          refundable: false,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          status: "failed",
          reason: "Model output was not valid JSON.",
          refundable: false,
        };
      }

      const candidatesRaw = (parsed as { candidates?: unknown })?.candidates;
      if (!Array.isArray(candidatesRaw)) {
        return {
          status: "failed",
          reason: "Model output did not match the schema.",
          refundable: false,
        };
      }

      const candidates = candidatesRaw
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .slice(0, maxCandidates);

      if (candidates.length === 0) {
        return {
          status: "failed",
          reason: "Model returned no usable candidates.",
          refundable: false,
        };
      }

      const promptTokens =
        typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : undefined;
      const completionTokens =
        typeof payload.usage?.completion_tokens === "number"
          ? payload.usage.completion_tokens
          : undefined;

      return {
        status: "ok",
        candidates,
        usage: {
          promptTokens: promptTokens ?? 0,
          completionTokens: completionTokens ?? 0,
        },
      };
    },
  };
}
