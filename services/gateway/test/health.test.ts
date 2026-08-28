import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createGatewayConfig } from "../src/config.js";

const TEST_ENV = {
  AXIOM_ENV: "test",
  LOG_LEVEL: "error",
  GEMINI_API_KEY: "test-key-gemini",
  GROQ_API_KEY: "test-key-groq",
  MISTRAL_API_KEY: "test-key-mistral",
  SILICONFLOW_API_KEY: "test-key-sf",
  NVIDIA_NIM_API_KEY: "test-key-nim",
};

describe("gateway scaffold", () => {
  it("reports liveness with the canonical health body", async () => {
    const app = await buildApp(createGatewayConfig(TEST_ENV));
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        service: "axiom-gateway",
        version: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });

  it("lists a model catalog built from configured providers", async () => {
    const app = await buildApp(createGatewayConfig(TEST_ENV));
    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      expect(response.statusCode).toBe(200);
      const models = response.json().data.map((m: { id: string }) => m.id);
      // All five dev providers hold keys, so their catalog entries appear.
      expect(models).toContain("gemini-3.6-flash");
      expect(models).toContain("openai/gpt-oss-120b");
      expect(models.length).toBeGreaterThanOrEqual(5);
    } finally {
      await app.close();
    }
  });

  it("serves an empty catalog when no provider keys are configured", async () => {
    const app = await buildApp(
      createGatewayConfig({
        AXIOM_ENV: "test",
        LOG_LEVEL: "error",
        // Blank out any keys inherited from the developer environment.
        GEMINI_API_KEY: "",
        GROQ_API_KEY: "",
        MISTRAL_API_KEY: "",
        SILICONFLOW_API_KEY: "",
        NVIDIA_NIM_API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("serves prometheus metrics with http request duration buckets", async () => {
    const app = await buildApp(createGatewayConfig(TEST_ENV));
    try {
      await app.inject({ method: "GET", url: "/healthz" });
      const response = await app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain("# HELP http_server_request_duration_seconds");
      expect(response.body).toContain('http_server_requests_total{job="gateway",method="GET",route="/healthz",status="200"}');
    } finally {
      await app.close();
    }
  });

  it("maps unknown routes to the axiom error contract", async () => {
    const app = await buildApp(createGatewayConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }));
    try {
      const response = await app.inject({ method: "GET", url: "/nope" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "AXIOM_NOT_FOUND", message: "Route not found.", retryable: false },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects invalid routing configuration at startup", () => {
    expect(() =>
      createGatewayConfig({
        AXIOM_ENV: "test",
        GATEWAY_ROUTING: "{not json",
      }),
    ).toThrow(/GATEWAY_ROUTING/i);
  });
});
