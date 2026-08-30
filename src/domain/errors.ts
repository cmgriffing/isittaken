export type SearchValidationCode =
  "invalid_seed" | "invalid_injected" | "over_limit" | "unsupported_scope";

/** Raised before any upstream provider is contacted. */
export class SearchValidationError extends Error {
  readonly code: SearchValidationCode;

  constructor(code: SearchValidationCode, message: string) {
    super(message);
    this.name = "SearchValidationError";
    this.code = code;
  }
}
