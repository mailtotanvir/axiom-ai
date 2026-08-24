/**
 * Per-provider circuit breaker (G5): CLOSED → OPEN after
 * `failureThreshold` consecutive failures; after `cooldownMs` a HALF_OPEN
 * probe is allowed — success closes, failure re-opens. Clock-injectable for
 * deterministic tests.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

interface BreakerRuntimeState {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
}

function initialState(): BreakerRuntimeState {
  return { state: "closed", consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
}

export class CircuitBreaker {
  private readonly runtime = new Map<string, BreakerRuntimeState>();

  constructor(
    private readonly options: Required<BreakerOptions>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a request to this provider may be attempted right now. */
  canAttempt(providerId: string): boolean {
    const state = this.runtime.get(providerId);
    if (state === undefined) {
      return true;
    }
    if (state.state === "open") {
      if (this.now() - state.openedAt >= this.options.cooldownMs) {
        state.state = "half_open";
        state.probeInFlight = false;
      } else {
        return false;
      }
    }
    if (state.state === "half_open" && state.probeInFlight) {
      return false;
    }
    if (state.state === "half_open") {
      state.probeInFlight = true;
    }
    return true;
  }

  recordSuccess(providerId: string): void {
    this.runtime.set(providerId, initialState());
  }

  recordFailure(providerId: string): void {
    const state = this.runtime.get(providerId) ?? initialState();
    state.consecutiveFailures += 1;

    if (state.state === "half_open" || state.consecutiveFailures >= this.options.failureThreshold) {
      state.state = "open";
      state.openedAt = this.now();
      state.consecutiveFailures = 0;
      state.probeInFlight = false;
    }
    this.runtime.set(providerId, state);
  }

  snapshot(providerId: string): { state: BreakerState; consecutiveFailures: number } {
    const state = this.runtime.get(providerId) ?? initialState();
    // Report half_open transitions triggered by time passage.
    if (state.state === "open" && this.now() - state.openedAt >= this.options.cooldownMs) {
      return { state: "half_open", consecutiveFailures: 0 };
    }
    return { state: state.state, consecutiveFailures: state.consecutiveFailures };
  }
}
