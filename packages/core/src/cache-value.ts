/**
 * Versioned cache-value envelope: producers store `{ version, data }` so a
 * decoder or prompt change can safely invalidate old representations.
 */
export function encodeVersionedValue(version: number, data: unknown): string {
  return JSON.stringify({ version, data });
}

/**
 * Decode a versioned cache value. Returns `null` when the payload is not
 * parseable, not an envelope, or carries an unexpected version — the caller
 * must treat that as a cache miss.
 */
export function decodeVersionedValue<T>(valueJson: string, expectedVersion: number): T | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as { version?: unknown; data?: unknown };
    if (typeof envelope.version !== "number" || envelope.version !== expectedVersion) {
      return null;
    }
    return envelope.data as T;
  } catch {
    return null;
  }
}
