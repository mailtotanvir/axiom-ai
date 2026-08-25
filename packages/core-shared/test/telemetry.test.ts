/**
 * Tests for the O1 LLM semantic-convention span helpers: attribute names
 * follow Gen-AI conventions and usage/cost land on the same span.
 */

import { describe, expect, it, vi } from "vitest";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import { axiomAttr, initTelemetry, llmAttr, withLlmSpan } from "../src/telemetry.js";
import type { TelemetryHandle } from "../src/telemetry.js";

async function captureSpans(
  fn: (handle: TelemetryHandle, exported: ReadableSpan[]) => Promise<void>,
): Promise<void> {
  const exported: ReadableSpan[] = [];
  const collector: SpanProcessor = {
    onStart: () => undefined,
    onEnd: (span) => {
      exported.push(span);
    },
    shutdown: async () => undefined,
    forceFlush: async () => undefined,
  };
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(collector);
  provider.register();
  const handle = {
    tracer: provider.getTracer("test"),
    shutdown: async () => provider.shutdown(),
  };
  try {
    await fn(handle, exported);
  } finally {
    await handle.shutdown();
    vi.restoreAllMocks();
  }
}

describe("LLM semantic conventions", () => {
  it("exposes stable Gen-AI and Axiom attribute names", () => {
    expect(llmAttr.system).toBe("gen_ai.system");
    expect(llmAttr.requestModel).toBe("gen_ai.request.model");
    expect(llmAttr.inputTokens).toBe("gen_ai.usage.input_tokens");
    expect(llmAttr.outputTokens).toBe("gen_ai.usage.output_tokens");
    expect(axiomAttr.tenantId).toBe("axiom.tenant.id");
    expect(axiomAttr.costUsd).toBe("axiom.cost.usd");
  });

  it("withLlmSpan records usage, cost, and model on the completed span", async () => {
    await captureSpans(async (handle, exported) => {
      const answer = await withLlmSpan(
        handle.tracer,
        "chat.completion",
        {
          [llmAttr.system]: "groq",
          [llmAttr.requestModel]: "openai/gpt-oss-120b",
          [axiomAttr.tenantId]: "tenant-a",
        },
        async () => ({
          value: "ok",
          outcome: {
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
            responseModel: "openai/gpt-oss-120b",
            finishReason: "stop",
            costUsd: 0.000021,
          },
        }),
      );
      expect(answer).toBe("ok");

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exported).toHaveLength(1);
      const attrs = exported[0]!.attributes;
      expect(attrs[llmAttr.inputTokens]).toBe(12);
      expect(attrs[llmAttr.totalTokens]).toBe(17);
      expect(attrs[llmAttr.responseModel]).toBe("openai/gpt-oss-120b");
      expect(attrs[axiomAttr.costUsd]).toBeCloseTo(0.000021, 9);
      expect(attrs["axiom.tenant.id"]).toBe("tenant-a");
    });
  });

  it("withLlmSpan marks failures with an error status", async () => {
    await captureSpans(async (handle, exported) => {
      await expect(
        withLlmSpan(handle.tracer, "chat.completion", {}, async () => {
          throw new Error("upstream down");
        }),
      ).rejects.toThrow("upstream down");

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exported).toHaveLength(1);
      expect(exported[0]!.status.code).toBe(2);
      expect(exported[0]!.status.message).toBe("upstream down");
    });
  });

  it("initTelemetry stays inert without an OTLP endpoint and is idempotent", () => {
    const first = initTelemetry({ serviceName: "axiom-test-inert", serviceVersion: "0.0.0" });
    const second = initTelemetry({ serviceName: "axiom-test-inert", serviceVersion: "0.0.0" });
    expect(second).toBe(first);
  });
});
