import { describe, expect, it } from "vitest";

import { InMemoryRateLimiter } from "../src/ratelimit/rateLimiter.js";
import type { TenantContext } from "@axiom-ai/core";
import { estimateTokens, estimatePromptTokens, resolveUsage } from "../src/metering/usage.js";

const LIMITS = {
  free: { requestsPerMinute: 3, tokensPerMinute: 100 },
  pro: { requestsPerMinute: 1_000, tokensPerMinute: 100_000 },
  enterprise: { requestsPerMinute: 10_000, tokensPerMinute: 1_000_000 },
};

function tenant(tier: TenantContext["rateLimitTier"] = "free"): TenantContext {
  return { tenantId: `t-${tier}`, projectId: "p", allowedModels: [], rateLimitTier: tier };
}

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit then denies with reset metadata", async () => {
    const limiter = new InMemoryRateLimiter(LIMITS);
    const t = tenant("free");
    const base = Date.now();

    for (let i = 0; i < 3; i += 1) {
      const decision = await limiter.consume(t, base + i);
      expect(decision.allowed).toBe(true);
    }
    const denied = await limiter.consume(t, base + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.limit).toBe(3);
    expect(denied.resetAtSeconds).toBe(Math.floor((base + 60_000) / 1000));
  });

  it("slides the window: old entries expire", async () => {
    const limiter = new InMemoryRateLimiter(LIMITS);
    const t = tenant();
    const base = Date.now();

    await limiter.consume(t, base);
    await limiter.consume(t, base + 1);
    await limiter.consume(t, base + 2);

    const later = await limiter.consume(t, base + 61_000);
    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(2); // two fresh entries in window
  });

  it("tracks token budgets per tenant", async () => {
    const limiter = new InMemoryRateLimiter(LIMITS);
    const t = tenant("free");
    await limiter.recordTokens(t, 60);
    expect(await limiter.tokenBudget(t)).toBe(40);
    await limiter.recordTokens(t, 100);
    expect(await limiter.tokenBudget(t)).toBe(0);
  });
});

describe("usage estimation", () => {
  it("estimates prompt tokens including framing overhead", () => {
    const request = {
      model: "m",
      messages: [
        { role: "system" as const, content: "You are terse." },
        { role: "user" as const, content: "Hello there" },
      ],
    };
    const total = estimatePromptTokens(request);
    expect(total).toBeGreaterThan(estimateTokens("You are terse.Hello there"));
  });

  it("prefers reported usage and reports zero drift on exact fixtures", () => {
    const request = {
      model: "m",
      messages: [{ role: "user" as const, content: "Say hello." }],
    };
    const outcome = resolveUsage(request, "Hello!", {
      promptTokens: 12,
      completionTokens: 5,
    });
    expect(outcome.source).toBe("reported");
    expect(outcome.promptTokens).toBe(12);
    expect(outcome.completionTokens).toBe(5);
    expect(outcome.reconciliationDelta).toBeGreaterThanOrEqual(0);
  });

  it("falls back to estimates when upstream omits usage", () => {
    const request = {
      model: "m",
      messages: [{ role: "user" as const, content: "Say hello." }],
    };
    const outcome = resolveUsage(request, "Hello!", undefined);
    expect(outcome.source).toBe("estimated");
    expect(outcome.completionTokens).toBe(estimateTokens("Hello!"));
    expect(outcome.totalTokens).toBeGreaterThan(0);
  });
});
