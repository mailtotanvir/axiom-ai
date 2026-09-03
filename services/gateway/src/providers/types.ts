/**
 * Provider adapter contract (G1). Adapters translate the unified
 * ChatCompletionRequest to an upstream wire format and return either raw
 * JSON or a raw SSE byte stream; the gateway owns parsing, metering, and
 * client delivery.
 */

import type {
  ChatCompletionRequest,
  ProviderId,
} from "@tanvir1971/core";

export type { ProviderId };

export interface UpstreamCall {
  body: ChatCompletionRequest;
  signal: AbortSignal;
  /** W3C trace-context and internal correlation headers. */
  headers?: Record<string, string>;
}

export interface UpstreamSuccess {
  ok: true;
  status: number;
  /** Raw upstream bytes for streaming responses (SSE passthrough). */
  stream?: ReadableStream<Uint8Array>;
  /**
   * Parsed non-streaming body in the upstream's native wire shape. The
   * gateway forwards it verbatim (fidelity-first proxy semantics); metering
   * reads usage out of it without mutating it.
   */
  json?: unknown;
}

export type UpstreamFailureReason =
  | "network_error"
  | "timeout"
  | "rate_limited"
  | "upstream_error";

export interface UpstreamFailure {
  ok: false;
  reason: UpstreamFailureReason;
  status?: number;
  message?: string;
  /** True when the request may succeed on retry/failover. */
  retryable: boolean;
}

export type UpstreamResult = UpstreamSuccess | UpstreamFailure;

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly baseUrl: string;
  /** False when no API key is present in the environment (key-gated). */
  isConfigured(): boolean;
  complete(call: UpstreamCall): Promise<UpstreamResult>;
  stream(call: UpstreamCall): Promise<UpstreamResult>;
}
