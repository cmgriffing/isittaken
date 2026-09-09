/** Minimal structural type for registered tool doubles in tests. */
export interface RegisteredToolLike {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options: { signal?: AbortSignal }) => unknown;
}
