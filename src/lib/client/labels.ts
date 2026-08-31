export const PROVENANCE_LABELS: Record<string, string> = {
  input: "your word",
  "wordnik-synonym": "synonym",
  "wordnik-related": "related word",
  openrouter: "AI idea",
  "injected-synonym": "injected synonym",
  "injected-creative": "injected idea",
};

/**
 * Per-registry status labels. Registry-neutral: the same verdict vocabulary
 * applies to every registry in the lineup.
 */
export const REGISTRY_STATUS_LABELS: Record<string, string> = {
  available: "available",
  taken: "taken",
  invalid: "invalid name",
  unknown: "unknown — try again",
  pending: "checking…",
};
