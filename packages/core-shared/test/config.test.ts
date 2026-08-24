import { describe, expect, it } from "vitest";

import {
  baseConfigSchema,
  ConfigurationError,
  loadConfig,
  providerKeysSchema,
  serviceEndpointsSchema,
} from "../src/config.js";

describe("loadConfig", () => {
  it("applies development defaults", () => {
    const config = loadConfig(baseConfigSchema, {});
    expect(config.AXIOM_ENV).toBe("development");
  });

  it("parses CLICKHOUSE_NODES comma lists", () => {
    const config = loadConfig(baseConfigSchema, {
      CLICKHOUSE_NODES: " ch-01.internal:8123 , ch-02.internal:8123 ",
    });
    expect(config.CLICKHOUSE_NODES).toEqual(["ch-01.internal:8123", "ch-02.internal:8123"]);
  });

  it("rejects invalid AXIOM_ENV values", () => {
    expect(() => loadConfig(baseConfigSchema, { AXIOM_ENV: "chaos" })).toThrow(ConfigurationError);
  });

  it("rejects malformed URLs", () => {
    expect(() => loadConfig(baseConfigSchema, { REDIS_PRIMARY_URL: "not-a-url" })).toThrow(
      ConfigurationError,
    );
  });

  it("requires a strong inter-service secret in production", () => {
    const env = {
      AXIOM_ENV: "production",
      AXIOM_INTER_SERVICE_SECRET: "short",
      POSTGRES_DB_URI: "postgresql://db_user:pw@pg-master.internal:5432/axiom_metadata",
    };
    expect(() => loadConfig(baseConfigSchema, env)).toThrow(/AXIOM_INTER_SERVICE_SECRET/);
    expect(() =>
      loadConfig(baseConfigSchema, {
        ...env,
        AXIOM_INTER_SERVICE_SECRET: "a".repeat(32),
      }),
    ).not.toThrow();
  });

  it("defaults GEMINI_MODEL to gemini-3.6-flash", () => {
    const config = loadConfig(providerKeysSchema, {});
    expect(config.GEMINI_MODEL).toBe("gemini-3.6-flash");
  });

  it("collects multiple issues into one error", () => {
    try {
      loadConfig(providerKeysSchema.merge(serviceEndpointsSchema), {
        GATEWAY_INTERNAL_URL: "::bad::",
        RAG_PIPELINE_INTERNAL_URL: "also-bad",
      });
      expect.unreachable("expected ConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
