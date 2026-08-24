/**
 * OpenAI-compatible adapter base (G1). Gemini, Groq, Mistral, SiliconFlow,
 * NVIDIA NIM, and OpenAI all expose the chat-completions wire format, so a
 * single implementation parameterized by endpoint + credential covers them
 * (ADR 0006). Handles camelCase (unified) ↔ snake_case (wire) translation.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, TokenUsage } from "@axiom-ai/core";

import { classifyFailure, type UpstreamFailureClassification } from "./classify.js";
import type { ProviderAdapter, ProviderId, UpstreamCall, UpstreamResult } from "./types.js";

export interface OpenAiCompatibleConfig {
  id: ProviderId;
  baseUrl: string;
  apiKey: string | undefined;
  /** Milliseconds; aborts the upstream call when exceeded. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface WireResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface WireChatResponse {
  id?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  usage?: WireResponseUsage;
}

/** Unified (camelCase) request → OpenAI wire (snake_case). */
export function toWireRequest(
  body: ChatCompletionRequest,
  providerId?: ProviderId,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    model: body.model,
    messages: body.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
      ...(message.name !== undefined ? { name: message.name } : {}),
    })),
  };
  if (body.tools !== undefined) {
    wire.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema ?? {},
      },
    }));
  }
  if (body.temperature !== undefined) wire.temperature = body.temperature;
  if (body.topP !== undefined) wire.top_p = body.topP;
  if (body.maxTokens !== undefined) wire.max_tokens = body.maxTokens;
  if (body.stopSequences !== undefined) wire.stop = body.stopSequences;
  wire.stream = body.stream ?? false;
  if (wire.stream === true) {
    // Ask every compatible upstream for usage totals inside the final chunk.
    wire.stream_options = { include_usage: true };
  }
  // Prompt-cache routing hint is OpenAI-specific; strict providers reject
  // unknown fields, so it is only forwarded where supported.
  if (body.promptCacheKey !== undefined && providerId === "openai") {
    wire.prompt_cache_key = body.promptCacheKey;
  }
  return wire;
}

/** OpenAI wire response → unified shape. */
export function fromWireResponse(json: unknown): ChatCompletionResponse {
  const wire = json as WireChatResponse;
  const choice = wire.choices?.[0];
  const usage = wire.usage ?? {};
  const tokens: TokenUsage = {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
  return {
    id: wire.id ?? "",
    model: wire.model ?? "",
    created: wire.created ?? Math.floor(Date.now() / 1000),
    message: {
      role: "assistant",
      content: choice?.message?.content ?? "",
    },
    usage: tokens,
    finishReason: normalizeFinishReason(choice?.finish_reason),
  };
}

function normalizeFinishReason(reason: string | null | undefined): ChatCompletionResponse["finishReason"] {
  switch (reason) {
    case "length":
    case "tool_calls":
    case "content_filter":
      return reason;
    default:
      return "stop";
  }
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly baseUrl: string;

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async complete(call: UpstreamCall): Promise<UpstreamResult> {
    return this.send({ ...call, body: { ...call.body, stream: false } });
  }

  async stream(call: UpstreamCall): Promise<UpstreamResult> {
    return this.send({ ...call, body: { ...call.body, stream: true } });
  }

  private async send(call: UpstreamCall): Promise<UpstreamResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        reason: "network_error",
        message: `provider '${this.id}' not configured`,
        retryable: false,
      };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    call.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("upstream timeout")),
      this.timeoutMs,
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          accept: call.body.stream === true ? "text/event-stream" : "application/json",
          ...call.headers,
        },
        body: JSON.stringify(toWireRequest(call.body, this.id)),
      });

      if (!response.ok) {
        const classification: UpstreamFailureClassification = classifyFailure(
          response.status,
          await safeErrorText(response),
        );
        return classification;
      }
      if (response.body === null) {
        return {
          ok: false,
          reason: "upstream_error",
          status: response.status,
          message: "empty body",
          retryable: false,
        };
      }

      if (call.body.stream === true) {
        return { ok: true, status: response.status, stream: response.body };
      }
      // Forward the native wire body verbatim; metering reads usage from it.
      return { ok: true, status: response.status, json: await response.json() };
    } catch (error) {
      if (call.signal.aborted) {
        return { ok: false, reason: "timeout", message: "client aborted", retryable: false };
      }
      if (controller.signal.aborted) {
        return { ok: false, reason: "timeout", message: "upstream timeout", retryable: true };
      }
      return {
        ok: false,
        reason: "network_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
      call.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return `HTTP ${response.status}`;
  }
}
