/** Maps upstream failure signals to retryability + reason (shared by adapters). */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export type UpstreamFailureClassification = {
  ok: false;
  reason: "network_error" | "timeout" | "rate_limited" | "upstream_error";
  status?: number;
  message: string;
  retryable: boolean;
};

export function classifyFailure(status: number, message: string): UpstreamFailureClassification {
  return {
    ok: false,
    status,
    reason: status === 429 ? "rate_limited" : "upstream_error",
    retryable: RETRYABLE_STATUS.has(status),
    message,
  };
}
