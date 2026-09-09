/**
 * Ambient type declarations for the WebMCP draft browser API.
 *
 * Pinned to the W3C WebMCP CG draft report dated 26 August 2026. These
 * declarations cover ONLY the surface this adapter consumes; the full draft
 * is not reproduced here. Spec churn should require changes to exactly this
 * file (and `adapter.ts`), enforced by tests/contract capabilities checks.
 */

interface ModelContextToolAnnotations {
  /** The tool does not mutate meaningful state. */
  readOnlyHint?: boolean;
  /** Tool results can carry content derived from third parties. */
  untrustedContentHint?: boolean;
  [key: string]: unknown;
}

/** JSON Schema (draft 2020-12) object describing a tool's input. */
interface ModelContextJsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

interface ModelContextExecuteOptions {
  /** Abort signal cancelled by the caller (agent cancel / timeout). */
  signal?: AbortSignal;
  [key: string]: unknown;
}

interface ModelContextToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: ModelContextJsonSchema;
  execute: (
    input: Record<string, unknown>,
    options: ModelContextExecuteOptions,
  ) => unknown | Promise<unknown>;
  annotations?: ModelContextToolAnnotations;
  [key: string]: unknown;
}

interface ModelContext {
  registerTool(tool: ModelContextToolDefinition): unknown;
  [key: string]: unknown;
}

interface Document {
  /** Present only in draft-API-enabled browsers (secure contexts). */
  modelContext?: ModelContext;
}
