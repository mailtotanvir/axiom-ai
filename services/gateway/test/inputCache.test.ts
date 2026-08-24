import { describe, expect, it, vi } from "vitest";

import {
  InMemoryCacheStore,
  InputCache,
  stableStringify,
} from "../src/cache/inputCache.js";
import type { ChatCompletionRequest } from "@axiom-ai/core";

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

const OPTIONS = { enabled: true, ttlSeconds: 60, maxEntryBytes: 64 * 1024 };

describe("stableStringify", () => {
  it("is invariant to object key ordering", () => {
    const a = stableStringify({ b: 1, a: { y: 2, x: [3, { d: 4, c: 5 }] } });
    const b = stableStringify({ a: { x: [3, { c: 5, d: 4 }], y: 2 }, b: 1 });
    expect(a).toBe(b);
  });
});

describe("InputCache", () => {
  it("produces stable keys and separates tenants", () => {
    const cache = new InputCache(new InMemoryCacheStore(), OPTIONS);
    const keyA = cache.keyFor("tenant-a", makeRequest());
    const keyAgain = cache.keyFor("tenant-a", makeRequest());
    const keyB = cache.keyFor("tenant-b", makeRequest());

    expect(keyA).toBe(keyAgain);
    expect(keyA).not.toBe(keyB);
  });

  it("includes sampling parameters in the identity", () => {
    const cache = new InputCache(new InMemoryCacheStore(), OPTIONS);
    expect(cache.keyFor("t", makeRequest())).not.toBe(
      cache.keyFor("t", makeRequest({ temperature: 0.7 })),
    );
  });

  it("round-trips envelopes and honors disabled mode", async () => {
    const cache = new InputCache(new InMemoryCacheStore(), OPTIONS);
    const key = cache.keyFor("t", makeRequest());
    const envelope = {
      provider: "groq",
      model: "m",
      status: 200,
      contentType: "application/json",
      body: "{}",
      streamed: false,
      usage: { promptTokens: 1, completionTokens: 2 },
    };
    await cache.store(key, envelope);
    await expect(cache.lookup(key)).resolves.toMatchObject(envelope);

    const off = new InputCache(new InMemoryCacheStore(), { ...OPTIONS, enabled: false });
    await expect(off.lookup(key)).resolves.toBeUndefined();
    await expect(off.store(key, envelope)).resolves.toBe(false);
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const cache = new InputCache(new InMemoryCacheStore(), { ...OPTIONS, ttlSeconds: 30 });
      const key = cache.keyFor("t", makeRequest());
      await cache.store(key, {
        provider: "p",
        model: "m",
        status: 200,
        contentType: "application/json",
        body: "{}",
        streamed: false,
        usage: { promptTokens: 0, completionTokens: 0 },
      });
      await expect(cache.lookup(key)).resolves.toBeDefined();

      vi.advanceTimersByTime(31_000);
      await expect(cache.lookup(key)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses entries above the size budget", async () => {
    const tiny = new InputCache(new InMemoryCacheStore(), { ...OPTIONS, maxEntryBytes: 1024 });
    const key = tiny.keyFor("t", makeRequest());
    const stored = await tiny.store(key, {
      provider: "p",
      model: "m",
      status: 200,
      contentType: "application/json",
      body: "x".repeat(4096),
      streamed: false,
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    expect(stored).toBe(false);
    await expect(tiny.lookup(key)).resolves.toBeUndefined();
  });

  it("collapses concurrent loads via dedupe", async () => {
    const cache = new InputCache(new InMemoryCacheStore(), OPTIONS);
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.dedupe("sf-key", async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `result-${calls}`;
        }),
      ),
    );

    expect(calls).toBe(1);
    expect(results[0]?.deduped).toBe(false);
    expect(results.slice(1).every((r) => r.deduped === true && r.value === "result-1")).toBe(true);
  });
});
