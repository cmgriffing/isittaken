export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  /** Sets an expired cookie to remove it from the browser. */
  expired?: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const {
    maxAgeSeconds,
    secure = true,
    httpOnly = true,
    sameSite = "Lax",
    path = "/",
    expired = false,
  } = options;

  const parts = [`${name}=${expired ? "" : value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  parts.push(`Max-Age=${expired ? 0 : (maxAgeSeconds ?? 315_36000)}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}
