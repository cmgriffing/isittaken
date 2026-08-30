/**
 * Minimal structured logger. Values never include secrets (API keys, tokens,
 * cookies); callers log identifiers and outcomes, not credentials.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL: LogLevel = ((): LogLevel => {
  const raw = process.env.LOG_LEVEL;
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
})();

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, message, ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger: Logger = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};
