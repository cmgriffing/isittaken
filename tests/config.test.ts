import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../src/config/server";

const baseEnv: Record<string, string> = {};

describe("loadServerConfig", () => {
  it("applies safe defaults for local development", () => {
    const config = loadServerConfig(baseEnv);
    expect(config.database.url).toBe("file:./local.db");
    expect(config.registries.npm.origin).toBe("https://registry.npmjs.org");
    expect(config.session.cookieSecure).toBe(false);
    expect(config.cache.ttl.registryAvailableMs).toBeLessThan(config.cache.ttl.registryTakenMs);
  });

  it("resolves per-registry settings from descriptor defaults and env overrides", () => {
    const config = loadServerConfig({
      REGISTRY_PYPI_RATE_LIMIT_PER_MINUTE: "45",
      REGISTRY_MAVEN_TIMEOUT_MS: "2500",
    });
    expect(config.registries.pypi.rateLimitPerMinute).toBe(45);
    expect(config.registries.pypi.timeoutMs).toBe(4000);
    expect(config.registries.maven.timeoutMs).toBe(2500);
    expect(config.registries.maven.rateLimitPerMinute).toBe(30);
    // Browser-venue registries have no server settings at all.
    expect("crates" in config.registries).toBe(false);
  });

  it("treats empty-string environment values as unset", () => {
    const config = loadServerConfig({ WORDNIK_API_KEY: "  ", NODE_ENV: "development" });
    expect(config.wordnik.apiKey).toBeUndefined();
  });

  it("defaults the session cookie to secure in production", () => {
    const config = loadServerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "libsql://prod.turso.io",
      DATABASE_AUTH_TOKEN: "token",
    });
    expect(config.app.isProduction).toBe(true);
    expect(config.session.cookieSecure).toBe(true);
  });

  it("rejects a local SQLite database in production without an override", () => {
    expect(() =>
      loadServerConfig({ NODE_ENV: "production", DATABASE_URL: "file:./local.db" }),
    ).toThrow(/Turso/);
  });

  it("allows the local SQLite override when explicitly enabled", () => {
    const config = loadServerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "file:./local.db",
      ALLOW_LOCAL_DB_IN_PRODUCTION: "true",
    });
    expect(config.database.url).toBe("file:./local.db");
  });

  it("rejects non-numeric limit overrides", () => {
    expect(() => loadServerConfig({ LIMIT_MAX_SEED_LENGTH: "ten" })).toThrow();
  });
});
