/**
 * Usage accounting (G6). Prefers provider-reported usage; estimates missing
 * pieces with tiktoken (o200k) so every request yields a meter record.
 * Reconciliation compares reported vs. estimated for drift monitoring.
 *
 * Prompt-cache accounting:
 * - OpenAI family: `usage.prompt_tokens_details.cached_tokens` — cached
 *   input is billed at a discount (default 0.5x).
 * - Anthropic: `cache_read_input_tokens` (0.1x) and
 *   `cache_creation_input_tokens` (1.25x).
 */

import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

import type { ChatCompletionRequest, ModelInfo, ProviderId } from "@axiom-ai/core";

const ENCODER = new Tiktoken(o200k_base);

/** Billing multipliers relative to the base input price. */
export const CACHE_PRICING = {
  openaiCachedInput: 0.5,
  anthropicCacheRead: 0.1,
  anthropicCacheWrite: 1.25,
} as const;

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return ENCODER.encode(text).length;
}

export function estimatePromptTokens(request: ChatCompletionRequest): number {
  // Per OpenAI guidance each message carries ~4 tokens of framing overhead.
  const overhead = 3 + (request.tools?.length ?? 0) * 8;
  return (
    request.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) + overhead
  );
}

export interface ReportedUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface UsageOutcome {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "reported" | "estimated" | "mixed";
  /** Absolute drift between reported and estimated completion counts. */
  reconciliationDelta: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Reads provider-reported usage out of an OpenAI-wire response body. */
export function extractReportedUsage(
  json: unknown,
): ReportedUsage | undefined {
  if (json === null || typeof json !== "object") {
    return undefined;
  }
  const usage = (
    json as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    }
  ).usage;
  if (usage === undefined || typeof usage !== "object") {
    return undefined;
  }
  const num = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;
  const reported: ReportedUsage = {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    cachedInputTokens: num(usage.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
  if (
    reported.promptTokens === undefined &&
    reported.completionTokens === undefined &&
    reported.cachedInputTokens === undefined &&
    reported.cacheWriteTokens === undefined &&
    reported.cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return reported;
}

export function resolveUsage(
  request: ChatCompletionRequest,
  completionText: string,
  reported: ReportedUsage | undefined,
): UsageOutcome {
  const estimatedCompletion = estimateTokens(completionText);
  const estimatedPrompt = estimatePromptTokens(request);

  const hasReportedPrompt = typeof reported?.promptTokens === "number" && reported.promptTokens > 0;
  const hasReportedCompletion =
    typeof reported?.completionTokens === "number" && reported.completionTokens > 0;

  let source: UsageOutcome["source"];
  if (hasReportedPrompt && hasReportedCompletion) {
    source = "reported";
  } else if (!hasReportedPrompt && !hasReportedCompletion) {
    source = "estimated";
  } else {
    source = "mixed";
  }

  const promptTokens = hasReportedPrompt ? (reported.promptTokens as number) : estimatedPrompt;
  const reportedCompletion = hasReportedCompletion
    ? (reported.completionTokens as number)
    : undefined;
  const completionTokens = reportedCompletion ?? estimatedCompletion;

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source,
    reconciliationDelta:
      reportedCompletion !== undefined ? Math.abs(reportedCompletion - estimatedCompletion) : 0,
    cachedInputTokens: reported?.cachedInputTokens ?? 0,
    cacheWriteTokens: reported?.cacheWriteTokens ?? 0,
    cacheReadTokens: reported?.cacheReadTokens ?? 0,
  };
}

/**
 * Provider-family-aware input caching price computation. Cached portions are
 * billed at the documented discounts; unknown models degrade to zero cost
 * (catalog metadata is optional).
 */
export function computeCostUsd(
  entry: ModelInfo | undefined,
  outcome: UsageOutcome,
  provider: ProviderId | string,
): number {
  const inputPrice = entry?.inputCostPerMillion ?? 0;
  const outputPrice = entry?.outputCostPerMillion ?? 0;
  const outputCost = (outcome.completionTokens / 1_000_000) * outputPrice;

  const uncachedPrompt = Math.max(
    0,
    outcome.promptTokens -
      outcome.cachedInputTokens -
      outcome.cacheReadTokens -
      outcome.cacheWriteTokens,
  );

  if (provider === "anthropic") {
    return (
      (uncachedPrompt / 1_000_000) * inputPrice +
      (outcome.cacheReadTokens / 1_000_000) * inputPrice * CACHE_PRICING.anthropicCacheRead +
      (outcome.cacheWriteTokens / 1_000_000) * inputPrice * CACHE_PRICING.anthropicCacheWrite +
      outputCost
    );
  }

  return (
    ((uncachedPrompt + outcome.cacheWriteTokens) / 1_000_000) * inputPrice +
    (outcome.cachedInputTokens / 1_000_000) *
      inputPrice *
      CACHE_PRICING.openaiCachedInput +
    outputCost
  );
}
