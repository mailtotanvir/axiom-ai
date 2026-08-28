import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createOpsConfig } from "../src/config.js";

describe("ops-observability scaffold", () => {
  const app = buildApp(createOpsConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }));

  it("reports liveness with the canonical health body", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "axiom-ops-observability",
    });
  });

  it("serves prometheus metrics with http request duration", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# HELP http_server_request_duration_seconds");
    expect(response.body).toContain('job="ops-observability"');
  });

  it("maps unknown routes to the axiom error contract", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("AXIOM_NOT_FOUND");
  });
});
