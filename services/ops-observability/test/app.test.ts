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

  it("maps unknown routes to the axiom error contract", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("AXIOM_NOT_FOUND");
  });
});
