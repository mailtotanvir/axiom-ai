/**
 * Unit tests for the Anthropic Messages adapter: header construction,
 * W3C trace-context propagation to the upstream, and wire-shape mapping.
 */

import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../src/providers/anthropic.js";
import type { UpstreamCall } from "../src/providers/types.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const ANTHROPIC_BODY = {
  id: "msg_1",
  model: "claude-3-5-sonnet",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 7, output_tokens: 3 },
};

function makeCall(overrides: Partial<UpstreamCall> = {}): UpstreamCall {
  return {
    body: { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hello" }] },
    signal: new AbortController().signal,
    ...overrides,
  } as UpstreamCall;
}

describe("AnthropicAdapter", () => {
  it("sends provider-native headers on every upstream call", async () => {
    const seen: Array<Record<string, string>> = [];
    const adapter = new AnthropicAdapter("sk-test", 1_000, async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return okResponse(ANTHROPIC_BODY);
    });

    await adapter.complete(makeCall());

    expect(seen).toHaveLength(1);
    expect(seen[0]!["x-api-key"]).toBe("sk-test");
    expect(seen[0]!["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!["content-type"]).toBe("application/json");
  });

  it("propagates W3C trace headers onto the upstream request", async () => {
    const seen: Array<Record<string, string>> = [];
    const adapter = new AnthropicAdapter("sk-test", 1_000, async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return okResponse(ANTHROPIC_BODY);
    });

    await adapter.complete(
      makeCall({ headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } }),
    );

    expect(seen[0]!.traceparent).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    // Propagation must not clobber provider auth headers.
    expect(seen[0]!["x-api-key"]).toBe("sk-test");
  });

  it("maps an Anthropic response into the OpenAI wire shape", async () => {
    const adapter = new AnthropicAdapter("sk-test", 1_000, async () =>
      okResponse(ANTHROPIC_BODY),
    );

    const result = await adapter.complete(makeCall());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const choices = result.json.choices as Array<{ message: { content: string } }>;
    expect(choices[0]!.message.content).toBe("hi");
    const usage = result.json.usage as Record<string, number>;
    expect(usage.total_tokens).toBe(10);
  });
});
