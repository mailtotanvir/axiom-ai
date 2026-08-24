/**
 * Usage accounting (G6). Prefers provider-reported usage; estimates missing
 * pieces with tiktoken (o200k) so every request yields a meter record.
 * Reconciliation compares reported vs. estimated for drift monitoring.
 */

import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

import type { ChatCompletionRequest } from "@axiom-ai/core";

const ENCODER = new Tiktoken(o200k_base);

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

export interface UsageOutcome {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "reported" | "estimated" | "mixed";
  /** Absolute drift between reported and estimated completion counts. */
  reconciliationDelta: number;
}

/** Reads provider-reported usage out of an OpenAI-wire response body. */
export function extractReportedUsage(json: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  if (json === null || typeof json !== "object") {
    return undefined;
  }
  const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (usage === undefined || typeof usage !== "object") {
    return undefined;
  }
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  return { promptTokens: prompt, completionTokens: completion };
}

export function resolveUsage(
  request: ChatCompletionRequest,
  completionText: string,
  reported: { promptTokens?: number; completionTokens?: number } | undefined,
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
  };
}
