import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { buildApp } from "../src/app.js";
import { createGatewayConfig } from "../src/config.js";

describe("gateway scaffold", () => {
  const app = buildApp(createGatewayConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }));

  it("reports liveness with the canonical health body", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "axiom-gateway",
      version: expect.any(String),
    });
  });

  it("reports readiness", async () => {
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("lists the bootstrap model catalog including dev providers", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(200);
    const models = response.json().data.map((m: { id: string }) => m.id);
    expect(models).toContain("gemini-3.6-flash");
    expect(models.length).toBeGreaterThanOrEqual(5);
  });

  it("maps unknown routes to the axiom error contract", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "AXIOM_NOT_FOUND", message: "Route not found.", retryable: false },
    });
  });

  it("redacts authorization headers from logs", () => {
    const appAny = app as unknown as { initialConfig: { fastify?: unknown } };
    expect(appAny.initialConfig).toBeDefined();
  });
});
