/**
 * Input-cache E2E (exact-match, tenant-scoped, streaming replay,
 * stampede protection). Uses the same mock upstreams as the main E2E with
 * the cache enabled.
 */

import { describe, expect, it } from "vitest";
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
  free: { requestsPerMinute: 100, tokensPerMinute: 1_000_000 },
  pro: { requestsPerMinute: 1_000_000, tokensPerMinute: 10_000_000 },
  enterprise: { requestsPerMinute: 10_000_000, tokensPerMinute: 100_000_000 },
};

const CACHE_OPTIONS = { enabled: true, ttlSeconds: 60, maxEntryBytes: 1024 * 1024 };

interface CacheHarness {
  app: FastifyInstance;
  providers: [MockUpstream];
  sink: CapturingSink;
  keyStore: InMemoryApiKeyStore;
  issueKey(tenantId: string): Promise<string>;
}

async function cacheHarness(
  overrides: Partial<{ ttlSeconds: number }> = {},
): Promise<CacheHarness> {
  const upstream = new MockUpstream();
  await upstream.start();
  const providers = [upstream];

  const adapters = new Map<string, ProviderAdapter>([
    ["mistral", new OpenAiCompatibleAdapter({ id: "mistral", baseUrl: upstream.url, apiKey: "mock-key", timeoutMs: 5_000 })],
    ["gemini", new OpenAiCompatibleAdapter({ id: "gemini", baseUrl: upstream.url, apiKey: "mock-key", timeoutMs: 5_000 })],
    ["groq", new OpenAiCompatibleAdapter({ id: "groq", baseUrl: upstream.url, apiKey: "mock-key", timeoutMs: 5_000 })],
  ]);

  const keyStore = new InMemoryApiKeyStore();
  const sink = new CapturingSink();

  const runtime: GatewayRuntime = {
    adapters,
    registry: ModelRegistry.forProviders(new Set(["mistral", "gemini", "groq"])),
    router: new Router(adapters, { defaultChain: [] }),
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    limiter: new InMemoryRateLimiter(TIER_LIMITS),
    keyStore,
    sinks: [sink],
    guardrails: new PassThroughGuardrails(),
    inputCache: new InputCache(new InMemoryCacheStore(), {
      ...CACHE_OPTIONS,
      ...overrides,
    }),
    anthropicAutoSystemCache: false,
    close: async () => undefined,
  };

  const app = await buildApp(
    {
      AXIOM_ENV: "test",
      AXIOM_INTER_SERVICE_SECRET: "dev-only-inter-service-secret",
      GATEWAY_PORT: 0,
      LOG_LEVEL: "error",
      GATEWAY_ROUTING: { defaultChain: [] },
      GATEWAY_TIER_LIMITS: TIER_LIMITS,
      GATEWAY_UPSTREAM_TIMEOUT_MS: 5_000,
      GATEWAY_INPUT_CACHE: { ...CACHE_OPTIONS, ...overrides },
      GEMINI_MODEL: "gemini-3.6-flash",
    },
    runtime,
  );
  await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    app,
    providers: providers as [MockUpstream],
    sink,
    keyStore,
    issueKey: async (tenantId: string) => {
      const issued = await keyStore.issue({
        tenantId,
        projectId: "p",
        rateLimitTier: "pro",
      });
      return issued.apiKey;
    },
  };
}

function chat(
  app: FastifyInstance,
  key: string,
  body: Record<string, unknown>,
): ReturnType<FastifyInstance["inject"]> {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: body,
  });
}

describe("gateway input cache (E2E)", () => {
  it("serves identical non-streaming requests from cache without an upstream call", async () => {
    const h = await cacheHarness();
    const key = await h.issueKey("tenant-cache");
    const body = {
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "Say hi" }],
    };

    const first = await chat(h.app, key, body);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-axiom-cache"]).toBe("MISS");
    expect(h.providers[0].requests.length).toBe(1);

    const second = await chat(h.app, key, body);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-axiom-cache"]).toBe("HIT");
    expect(second.headers["x-axiom-provider"]).toBe("mistral");
    expect(h.providers[0].requests.length).toBe(1); // no additional upstream hit
    expect(second.body).toBe(first.body);
  });

  it("never serves cross-tenant hits for identical payloads", async () => {
    const h = await cacheHarness();
    const tenantA = await h.issueKey("tenant-A");
    const tenantB = await h.issueKey("tenant-B");
    const body = {
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "Shared prompt" }],
    };

    await chat(h.app, tenantA, body);
    const secondTenant = await chat(h.app, tenantB, body);

    expect(secondTenant.headers["x-axiom-cache"]).toBe("MISS");
    expect(h.providers[0].requests.length).toBe(2);
  });

  it("replays cached SSE streams byte-for-byte", async () => {
    const h = await cacheHarness();
    const key = await h.issueKey("tenant-stream");
    const body = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "Stream please" }],
      stream: true,
    };

    const first = await chat(h.app, key, body);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-axiom-cache"]).toBe("MISS");
    expect(first.headers["x-axiom-provider"]).toBe("gemini");
    const firstBody = first.body;
    expect(firstBody).toContain("data: [DONE]");

    const second = await chat(h.app, key, body);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-axiom-cache"]).toBe("HIT");
    expect(second.headers["content-type"]).toContain("text/event-stream");
    expect(second.body).toBe(firstBody);
    expect(h.providers[0].requests.length).toBe(1);

    // Both deliveries metered; the replay is flagged as a cache hit at zero cost.
    const hits = h.sink.records.filter((r) => r.cacheHit === true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.costUsd).toBe(0);
    expect(hits[0]?.totalTokens).toBeGreaterThan(0);
  });

  it("collapses concurrent duplicate misses into one upstream call", async () => {
    const h = await cacheHarness();
    const key = await h.issueKey("tenant-stampede");
    const body = {
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "Stampede" }],
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => chat(h.app, key, body)),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(h.providers[0].requests.length).toBe(1);
    const deduped = responses.filter((r) => r.headers["x-axiom-cache"] === "DEDUPED");
    expect(deduped).toHaveLength(4);
  });

  it("excludes tool-calling requests from the exact-match cache", async () => {
    const h = await cacheHarness();
    const key = await h.issueKey("tenant-tools");
    const body = {
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "Tools" }],
      tools: [{ name: "clock", parametersJsonSchema: {} }],
    };

    await chat(h.app, key, body);
    const second = await chat(h.app, key, body);

    // No x-axiom-cache header on tool requests: they always go upstream.
    expect(second.headers["x-axiom-cache"]).toBeUndefined();
    expect(h.providers[0].requests.length).toBe(2);
  });

  it("expires entries after the configured TTL", async () => {
    const h = await cacheHarness({ ttlSeconds: 1 });
    const key = await h.issueKey("tenant-ttl");
    const body = {
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "Expiring" }],
    };

    await chat(h.app, key, body);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const afterTtl = await chat(h.app, key, body);

    expect(afterTtl.headers["x-axiom-cache"]).toBe("MISS");
    expect(h.providers[0].requests.length).toBe(2);
  }, 20_000);
});
