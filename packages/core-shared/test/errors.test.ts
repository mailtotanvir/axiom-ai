import { describe, expect, it } from "vitest";

import { AxiomError, errors } from "../src/errors.js";

describe("AxiomError", () => {
  it("maps codes to HTTP statuses", () => {
    expect(errors.unauthenticated().statusCode).toBe(401);
    expect(errors.forbiddenTenant().statusCode).toBe(403);
    expect(errors.quotaExceeded().statusCode).toBe(402);
    expect(errors.rateLimited(30).statusCode).toBe(429);
    expect(errors.upstreamTimeout("groq").statusCode).toBe(504);
    expect(errors.sandboxViolation("network egress attempt").statusCode).toBe(400);
  });

  it("serializes to a stable wire body", () => {
    const body = errors.modelNotAllowed("gemini-3.6-flash").toJSON();
    expect(body).toEqual({
      error: {
        code: "AXIOM_MODEL_NOT_ALLOWED",
        message: "Model 'gemini-3.6-flash' is not enabled for this tenant.",
        retryable: false,
      },
    });
  });

  it("includes details when provided", () => {
    const body = errors.allUpstreamsFailed(["gemini", "groq"]).toJSON();
    expect(body.error.details).toEqual({ providers: ["gemini", "groq"] });
    expect(body.error.retryable).toBe(true);
  });

  it("wraps unknown throwables as retryable internal errors", () => {
    const wrapped = AxiomError.from(new Error("boom"));
    expect(wrapped.code).toBe("AXIOM_INTERNAL");
    expect(wrapped.retryable).toBe(true);

    const passthrough = AxiomError.from(wrapped);
    expect(passthrough).toBe(wrapped);
  });
});
