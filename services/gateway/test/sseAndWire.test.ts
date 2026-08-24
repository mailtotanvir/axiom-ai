import { describe, expect, it } from "vitest";

import { SseTap } from "../src/providers/sse.js";
import { extractUsageFromSseData } from "../src/providers/sseUsage.js";
import { toWireRequest, fromWireResponse } from "../src/providers/openaiCompatible.js";

describe("SseTap", () => {
  it("forwards bytes untouched while parsing data lines", () => {
    const seen: string[] = [];
    const tap = new SseTap((event) => seen.push(event.data));

    const input = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n',
    );
    const forwarded = tap.push(input);
    tap.finish();

    expect(new TextDecoder().decode(forwarded)).toBe(new TextDecoder().decode(input));
    expect(seen).toHaveLength(2);
  });

  it("handles frames split across chunk boundaries", () => {
    const seen: string[] = [];
    const tap = new SseTap((event) => seen.push(event.data));
    const encoder = new TextEncoder();

    tap.push(encoder.encode('data: {"a":1}'));
    tap.push(encoder.encode('\n\ndata: {"b":2}\n\n'));
    tap.finish();

    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("extractUsageFromSseData", () => {
  it("finds usage objects containing braces in strings", () => {
    const tricky = 'data: {"choices":[{"delta":{"content":"}{ not braces"}}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}';
    expect(extractUsageFromSseData(tricky)).toEqual({
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
    });
  });

  it("returns null when usage is absent", () => {
    expect(extractUsageFromSseData('data: {"x":1}')).toBeNull();
  });
});

describe("wire translation", () => {
  it("maps unified camelCase request fields onto OpenAI snake_case", () => {
    const wire = toWireRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
      topP: 0.9,
      stopSequences: ["END"],
      stream: true,
    });
    expect(wire).toMatchObject({
      model: "m",
      max_tokens: 128,
      top_p: 0.9,
      stop: ["END"],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("maps wire responses back to the unified shape", () => {
    const unified = fromWireResponse({
      id: "abc",
      model: "m",
      choices: [{ message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    });
    expect(unified.message.content).toBe("yo");
    expect(unified.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
  });
});
