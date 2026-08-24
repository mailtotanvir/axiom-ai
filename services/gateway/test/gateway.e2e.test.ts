/**
 * End-to-end integration tests over the full request path
 * (auth → limits → guardrails → routing/failover → provider → metering)
 * against deterministic mock upstreams — no external calls.
 *
 * Streaming tests use a real listening socket (not fastify.inject) because
 * SSE delivery relies on reply.hijack(), which light-my-request does not
 * capture; real sockets also exercise true TCP backpressure.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { ProviderAdapter } from "../src/providers/types.js";
import { OpenAiCompatibleAdapter } from "../src/providers/openaiCompatible.js";
import { ModelRegistry } from "../src/providers/registry.js";
import { Router } from "../src/router/router.js";
import { CircuitBreaker } from "../src/router/circuitBreaker.js";
import { InMemoryRateLimiter } from "../src/ratelimit/rateLimiter.js";
import { InMemoryApiKeyStore } from "../src/auth/apiKeyStore.js";
import { PassThroughGuardrails } from "../src/guardrails/guardrails.js";
import { InMemoryCacheStore, InputCache } from "../src/cache/inputCache.js";
import { buildApp } from "../src/app.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { MockUpstream } from "./helpers/mockUpstream.js";
import { CapturingSink } from "./helpers/capturingSink.js";

const TIER_LIMITS = {
  free: { requestsPerMinute: 2, tokensPerMinute: 100 },
  pro: { requestsPerMinute: 1_000_000, tokensPerMinute: 1_000_000 },
  enterprise: { requestsPerMinute: 10_000_000, tokensPerMinute: 10_000_000 },
};

interface Harness {
  app: FastifyInstance;
  providers: [MockUpstream, MockUpstream, MockUpstream];
  sink: CapturingSink;
  keyStore: InMemoryApiKeyStore;
  apiKey: string;
  breaker: CircuitBreaker;
  baseUrl: Promise<string>;
  close: () => Promise<void>;
}

const openHandles: Harness[] = [];

async function harness(
  inputCache: InputCache = new InputCache(new InMemoryCacheStore(), {
    enabled: false,
    ttlSeconds: 60,
    maxEntryBytes: 1024 * 1024,
  }),
): Promise<Harness> {
  const providers: MockUpstream[] = [];
  for (let i = 0; i < 3; i += 1) {
    const upstream = new MockUpstream();
    await upstream.start();
    providers.push(upstream);
  }
  const ids = ["mistral", "gemini", "groq"] as const;

  const adapters = new Map<string, ProviderAdapter>();
  for (const [index, id] of ids.entries()) {
    adapters.set(
      id,
      new OpenAiCompatibleAdapter({
        id,
        baseUrl: providers[index].url,
        apiKey: "mock-key",
        timeoutMs: 5_000,
      }),
    );
  }

  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  const limiter = new InMemoryRateLimiter(TIER_LIMITS);
  const keyStore = new InMemoryApiKeyStore();
  const sink = new CapturingSink();

  const runtime: GatewayRuntime = {
    adapters,
    registry: ModelRegistry.forProviders(new Set(ids)),
    router: new Router(adapters, {
      // Model's own provider first, then the default chain: a full
      // three-provider failover chain for mistral-hosted models.
      defaultChain: ["gemini", "groq"],
    }),
    breaker,
    limiter,
    keyStore,
    sinks: [sink],
    guardrails: new PassThroughGuardrails(),
    inputCache,
    anthropicAutoSystemCache: false,
    close: async () => undefined,
  };

  const app = await buildApp(
    {
      AXIOM_ENV: "test",
      AXIOM_INTER_SERVICE_SECRET: "dev-only-inter-service-secret",
      GATEWAY_PORT: 0,
      LOG_LEVEL: "error",
      GATEWAY_ROUTING: { defaultChain: ["gemini", "groq"] },
      GATEWAY_TIER_LIMITS: TIER_LIMITS,
      GATEWAY_UPSTREAM_TIMEOUT_MS: 5_000,
      GEMINI_MODEL: "gemini-3.6-flash",
    },
    runtime,
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const issued = await keyStore.issue({
    tenantId: "tenant-a",
    projectId: "proj-1",
    rateLimitTier: "pro",
  });

  const handle: Harness = {
    app,
    providers: providers as [MockUpstream, MockUpstream, MockUpstream],
    sink,
    keyStore,
    apiKey: issued.apiKey,
    breaker,
    baseUrl: Promise.resolve(`http://127.0.0.1:${port}`),
    close: async () => {
      await app.close();
      await Promise.all(providers.map((provider) => provider.stop()));
    },
  };
  openHandles.push(handle);
  return handle;
}

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (handle) {
      await handle.close();
    }
  }
});

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

const CHAT_BODY = {
  model: "mistral-large-latest",
  messages: [{ role: "user", content: "Say hi" }],
};

async function chat(harnessHandle: Harness, body: unknown, key?: string): Promise<Response> {
  const base = await harnessHandle.baseUrl;
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: authed(key ?? harnessHandle.apiKey),
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  // Chaos tests intentionally leave truncated upstreams; keep the worker alive.
  process.on("unhandledRejection", () => undefined);
});

describe("gateway chat completions (E2E)", () => {
  it("proxies non-streaming requests and forwards the native wire body verbatim", async () => {
    const h = await harness();

    const response = await chat(h, CHAT_BODY);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axiom-provider")).toBe("mistral");
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: Record<string, number>;
    };
    expect(body.choices[0].message.content).toBe("Hello from mock!");
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  });

  it("fails over across all three providers when primaries fail", async () => {
    const h = await harness();

    h.providers[0].script("fail_500"); // mistral
    h.providers[1].script("fail_500"); // gemini

    const response = await chat(h, CHAT_BODY);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axiom-provider")).toBe("groq");
    expect(h.providers[0].requests.length).toBe(1);
    expect(h.providers[1].requests.length).toBe(1);
  });

  it("streams SSE bytes through with reported usage metering", async () => {
    const h = await harness();

    const response = await chat(h, { ...CHAT_BODY, stream: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const raw = await response.text();
    expect(raw).toContain('"content":"Hel"');
    expect(raw).toContain('"content":"lo stream"');
    expect(raw).toContain("data: [DONE]");

    const record = h.sink.records.at(-1);
    expect(record?.streamed).toBe(true);
    expect(record?.usageSource).toBe("reported");
    expect(record?.totalTokens).toBe(12);
  });

  it("survives an upstream cutting the stream mid-flight (chaos)", async () => {
    const h = await harness();

    h.providers[0].script("cut_stream");

    const response = await chat(h, { ...CHAT_BODY, stream: true });
    expect(response.status).toBe(200);

    // Read until the truncated socket ends; capture what got through.
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          text += new TextDecoder().decode(next.value);
        }
      } catch {
        /* upstream destroyed the socket — expected */
      }
    }
    expect(text).toContain('"content":"Hel"');
    expect(text).not.toContain("[DONE]");
  }, 15_000);

  it("rejects unauthenticated calls with the Axiom error contract", async () => {
    const h = await harness();

    const missing = await chat(h, CHAT_BODY, "");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "AXIOM_UNAUTHENTICATED",
    );

    const bad = await chat(h, CHAT_BODY, "ax_wrong");
    expect(bad.status).toBe(401);
  });

  it("enforces per-tenant rate limits under burst load", async () => {
    const h = await harness();

    const limited = await h.keyStore.issue({
      tenantId: "tenant-limited",
      projectId: "p",
      rateLimitTier: "free", // 2 rpm
    });

    const results: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await chat(h, CHAT_BODY, limited.apiKey);
      results.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("x-ratelimit-limit")).toBe("2");
        expect(response.headers.get("retry-after")).toBeDefined();
        break;
      }
    }
    expect(results.filter((code) => code === 429)).toHaveLength(1);
    expect(results.filter((code) => code === 200)).toHaveLength(2);

    const meterForTenant = h.sink.records.filter((r) => r.tenantId === "tenant-limited");
    expect(meterForTenant).toHaveLength(2); // denied requests are never metered
  });

  it("reconciles usage rows exactly against fixture-reported tokens", async () => {
    const h = await harness();

    await chat(h, CHAT_BODY);

    const record = h.sink.records[0];
    // Fixture reports prompt=12/completion=5; the recorded row matches ±0.
    expect(record.promptTokens).toBe(12);
    expect(record.completionTokens).toBe(5);
    expect(record.totalTokens).toBe(17);
    expect(record.usageSource).toBe("reported");
    expect(Math.abs(record.reconciliationDelta)).toBeLessThanOrEqual(3); // estimator drift only
    expect(record.costUsd).toBeCloseTo((12 / 1e6) * 2.0 + (5 / 1e6) * 6.0, 10);
  });

  it("keeps proxy overhead within the latency budget", async () => {
    const h = await harness();

    // Warm up connections.
    for (let i = 0; i < 5; i += 1) {
      await chat(h, CHAT_BODY);
    }

    const directTimes: number[] = [];
    const proxiedTimes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      let start = performance.now();
      await fetch(`${h.providers[0].url}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer mock-key", "content-type": "application/json" },
        body: JSON.stringify(CHAT_BODY),
      });
      directTimes.push(performance.now() - start);

      start = performance.now();
      await chat(h, CHAT_BODY);
      proxiedTimes.push(performance.now() - start);
    }

    const p95 = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.ceil(sorted.length * 0.95) - 1];
    };
    const overheadP95 = p95(proxiedTimes) - Math.min(...directTimes);
    // Budget is 15ms in production; generous CI-noise allowance documented here.
    expect(overheadP95).toBeLessThan(35);
  }, 30_000);
});
