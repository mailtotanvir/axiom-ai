import { describe, expect, it } from "vitest";

import { extractReportedUsage, computeCostUsd, resolveUsage } from "../src/metering/usage.js";
import {
  mapRequestToAnthropic,
  mapToOpenAiWire,
} from "../src/providers/anthropic.js";
import type { ModelInfo } from "@tanvir1971/core";

const ENTRY: ModelInfo = {
  id: "m",
  provider: "openai",
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsTools: false,
  modalities: ["text"],
  inputCostPerMillion: 1.0,
  outputCostPerMillion: 2.0,
};

describe("extractReportedUsage (input caching)", () => {
  it("reads OpenAI prompt_tokens_details.cached_tokens", () => {
    const reported = extractReportedUsage({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 768 } },
    });
    expect(reported?.promptTokens).toBe(1000);
    expect(reported?.cachedInputTokens).toBe(768);
  });

  it("reads Anthropic cache creation/read counts", () => {
    const reported = extractReportedUsage({
      choices: [{ message: { content: "x" } }],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 20,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 300,
      },
    });
    expect(reported?.cacheWriteTokens).toBe(1500);
    expect(reported?.cacheReadTokens).toBe(300);
  });
});

describe("computeCostUsd with cached input", () => {
  const base = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    source: "reported" as const,
    reconciliationDelta: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };

  it("bills OpenAI cached tokens at a discount", () => {
    const cost = computeCostUsd(
      ENTRY,
      { ...base, promptTokens: 1000, completionTokens: 100, cachedInputTokens: 800 },
      "openai",
    );
    // (200 uncached * $1 + 800 cached * $0.5)/1M + 100 * $2/1M
    expect(cost).toBeCloseTo((200 / 1e6) * 1.0 + (800 / 1e6) * 0.5 + (100 / 1e6) * 2.0, 12);
  });

  it("bills Anthropic reads at 0.1x and writes at 1.25x", () => {
    const cost = computeCostUsd(
      ENTRY,
      {
        ...base,
        promptTokens: 2000,
        completionTokens: 50,
        cacheWriteTokens: 1200,
        cacheReadTokens: 600,
      },
      "anthropic",
    );
    // 200 plain*1 + 600 read*0.1 + 1200 write*1.25 + 50 output*2 (per million)
    expect(cost).toBeCloseTo(
      (200 / 1e6) * 1.0 +
        (600 / 1e6) * 0.1 +
        (1200 / 1e6) * 1.25 +
        (50 / 1e6) * 2.0,
      12,
    );
  });
});

describe("resolveUsage carries cache token fields", () => {
  it("propagates provider-reported cache counters", () => {
    const outcome = resolveUsage(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      "hello",
      { promptTokens: 500, completionTokens: 5, cachedInputTokens: 400 },
    );
    expect(outcome.cachedInputTokens).toBe(400);
    expect(outcome.totalTokens).toBe(505);
  });
});

describe("Anthropic cache_control translation", () => {
  it("emits cache_control blocks for flagged messages", () => {
    const wire = mapRequestToAnthropic({
      model: "claude-x",
      messages: [
        { role: "system", content: "Long static instructions.", cacheControl: "ephemeral" },
        { role: "user", content: "Question" },
      ],
      maxTokens: 128,
    });
    expect(Array.isArray(wire.system)).toBe(true);
    expect(wire.system).toEqual([
      { type: "text", text: "Long static instructions.", cache_control: { type: "ephemeral" } },
    ]);
    expect(wire.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Question" }] },
    ]);
  });

  it("auto-marks the trailing system block when enabled", () => {
    const wire = mapRequestToAnthropic(
      {
        model: "claude-x",
        messages: [
          { role: "system", content: "Sys" },
          { role: "user", content: "Q" },
        ],
      },
      true,
    );
    expect(wire.system).toEqual([
      { type: "text", text: "Sys", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("maps Anthropic cache usage into the OpenAI wire body", () => {
    const mapped = mapToOpenAiWire({
      id: "msg_1",
      model: "claude-x",
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 900,
        output_tokens: 15,
        cache_creation_input_tokens: 700,
        cache_read_input_tokens: 100,
      },
    });
    expect(mapped.body.usage).toEqual({
      prompt_tokens: 900,
      completion_tokens: 15,
      total_tokens: 915,
      cache_creation_input_tokens: 700,
      cache_read_input_tokens: 100,
    });
  });
});
