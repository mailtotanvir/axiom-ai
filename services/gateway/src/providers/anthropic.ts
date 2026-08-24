/**
 * Anthropic Messages API adapter (G1). Anthropic does not speak the
 * OpenAI wire format, so this adapter translates requests, responses, and
 * the event-based SSE stream. Enabled only when ANTHROPIC_API_KEY is set.
 *
 * Prompt caching (input caching): messages/system flagged with
 * `cacheControl: "ephemeral"` in the unified shape become Anthropic
 * `cache_control` content blocks; cache_creation/cache_read token counts
 * from the response are surfaced for metering. When `autoSystemCache` is
 * enabled the trailing system block is marked automatically so tenants get
 * caching without changing payloads.
 */

import type { ChatCompletionRequest } from "@axiom-ai/core";

import type { ProviderAdapter, ProviderId, UpstreamCall, UpstreamResult } from "./types.js";
import { classifyFailure } from "./classify.js";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicResponse {
  id: string;
  model: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS_FALLBACK = 4096;

function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey ?? "",
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/** Unified message → Anthropic content blocks, honoring cache markers. */
function toContentBlocks(
  text: string,
  cacheControl: "ephemeral" | undefined,
): Array<AnthropicContentBlock> {
  const block: AnthropicContentBlock = { type: "text", text };
  if (cacheControl !== undefined) {
    block.cache_control = { type: "ephemeral" };
  }
  return [block];
}

export function mapRequestToAnthropic(
  body: ChatCompletionRequest,
  autoSystemCache = false,
): Record<string, unknown> {
  const systemMessages = body.messages.filter((m) => m.role === "system");
  const conversation = body.messages.filter((m) => m.role !== "system");

  let system: Array<AnthropicContentBlock> | undefined;
  if (systemMessages.length > 0) {
    system = systemMessages.map((m, index): AnthropicContentBlock => {
      const isLastSystem = index === systemMessages.length - 1;
      const mark = m.cacheControl ?? (autoSystemCache && isLastSystem ? "ephemeral" : undefined);
      return { type: "text", text: m.content, ...(mark !== undefined ? { cache_control: { type: "ephemeral" as const } } : {}) };
    });
  }

  const messages = conversation.map((m) => ({
    role: m.role,
    content: toContentBlocks(m.content, m.cacheControl),
  }));

  const payload: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.maxTokens ?? MAX_TOKENS_FALLBACK,
    stream: false,
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.topP !== undefined) payload.top_p = body.topP;
  if (body.stopSequences?.length) payload.stop_sequences = body.stopSequences;
  if (system !== undefined) payload.system = system;
  return payload;
}

export interface WireUsageWithCache {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Anthropic native response → OpenAI wire shape, so clients of the gateway
 * see one consistent response schema regardless of serving provider.
 * Cache token counts pass through for metering and client visibility.
 */
export function mapToOpenAiWire(body: AnthropicResponse): {
  body: Record<string, unknown>;
  usage: WireUsageWithCache;
} {
  const text = body.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const promptTokens = body.usage?.input_tokens ?? 0;
  const completionTokens = body.usage?.output_tokens ?? 0;
  const usage: WireUsageWithCache = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(body.usage?.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: body.usage.cache_creation_input_tokens }
      : {}),
    ...(body.usage?.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: body.usage.cache_read_input_tokens }
      : {}),
  };
  return {
    body: {
      id: body.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: mapStopReason(body.stop_reason),
        },
      ],
      usage,
    },
    usage,
  };
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: ProviderId = "anthropic";
  readonly baseUrl = BASE_URL;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Mark the trailing system block with cache_control automatically. */
    private readonly autoSystemCache = false,
  ) {}

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async complete(call: UpstreamCall): Promise<UpstreamResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${BASE_URL}/messages`, {
        method: "POST",
        signal: anyOf(call.signal, controller.signal),
        headers: anthropicHeaders(this.apiKey),
        body: JSON.stringify(mapRequestToAnthropic(call.body, this.autoSystemCache)),
      });
      if (!response.ok) {
        return classifyFailure(response.status, await safeText(response));
      }
      const body = (await response.json()) as AnthropicResponse;
      return { ok: true, status: response.status, json: mapToOpenAiWire(body).body };
    } catch (error) {
      return failureFrom(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async stream(_call: UpstreamCall): Promise<UpstreamResult> {
    // Streaming translation for Anthropic's event protocol lands with the
    // streaming hardening pass; failover treats this as a skipped provider.
    return {
      ok: false,
      reason: "upstream_error",
      message: "anthropic streaming not enabled",
      retryable: false,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function anyOf(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  a.addEventListener("abort", () => controller.abort(), { once: true });
  b.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

function failureFrom(error: unknown): UpstreamResult {
  return {
    ok: false,
    reason: "network_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
