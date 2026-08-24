import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "../src/router/circuitBreaker.js";

function fixedClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and blocks attempts", () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 }, clock.now);

    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.canAttempt("p")).toBe(true);
    breaker.recordFailure("p");

    expect(breaker.canAttempt("p")).toBe(false);
    expect(breaker.snapshot("p").state).toBe("open");
  });

  it("allows a half-open probe after cooldown and closes on success", () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 }, clock.now);

    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.canAttempt("p")).toBe(false);

    clock.advance(1_500);
    expect(breaker.snapshot("p").state).toBe("half_open");
    expect(breaker.canAttempt("p")).toBe(true); // probe granted
    expect(breaker.canAttempt("p")).toBe(false); // only one probe at a time

    breaker.recordSuccess("p");
    expect(breaker.snapshot("p").state).toBe("closed");
    expect(breaker.canAttempt("p")).toBe(true);
  });

  it("re-opens when the half-open probe fails", () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500 }, clock.now);

    breaker.recordFailure("p");
    clock.advance(600);
    expect(breaker.canAttempt("p")).toBe(true);
    breaker.recordFailure("p");

    expect(breaker.snapshot("p").state).toBe("open");
    clock.advance(100);
    expect(breaker.canAttempt("p")).toBe(false);
  });

  it("tracks providers independently", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    breaker.recordFailure("a");
    expect(breaker.canAttempt("a")).toBe(false);
    expect(breaker.canAttempt("b")).toBe(true);
  });
});
