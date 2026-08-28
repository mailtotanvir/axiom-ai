import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildServer, registerNotFoundHandler } from "../src/server.js";

describe("agent-runtime scaffold", () => {
  const app = buildServer();

  it("reports liveness", async () => {
    const response = await request(app).get("/healthz");
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      service: "axiom-agent-runtime",
    });
  });

  it("serves prometheus metrics with http request duration", async () => {
    const response = await request(app).get("/metrics");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("# HELP http_server_request_duration_seconds");
    expect(response.text).toContain('job="agent-runtime"');
  });

  it("accepts webhook test deliveries with 202", async () => {
    const response = await request(app)
      .post("/v1/webhooks/test")
      .set("content-type", "application/json")
      .send(JSON.stringify({ id: "evt_1" }));
    expect(response.statusCode).toBe(202);
    expect(response.body.accepted).toBe(true);
  });

  it("maps unknown routes to the axiom error contract", async () => {
    registerNotFoundHandler(app);
    const response = await request(app).get("/nope");
    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe("AXIOM_NOT_FOUND");
  });
});
