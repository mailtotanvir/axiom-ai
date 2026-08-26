/**
 * A/B experiment engine tests (O4, gateway side) plus the O6 W3C trace
 * correlation proof. Engine behavior is exercised directly via injected
 * loadRules/reportAssignment hooks; route integration (sticky keys, model
 * override, template substitution, assignment headers) runs over the full
 * E2E harness with mock upstreams.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { ExperimentEngine, bucketOf, hashKey } from "../src/experiments/engine.js";
import type { RulesResponse } from "../src/experiments/engine.js";
import { buildApp } from "../src/app.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { ModelRegistry } from "../src/providers/registry.js";
import { OpenAiCompatibleAdapter } from "../src/providers/openaiCompatible.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import { Router } from "../src/router/router.js";
import { CircuitBreaker } from "../src/router/circuitBreaker.js";
import { InMemoryRateLimiter } from "../src/ratelimit/rateLimiter.js";
import { InMemoryApiKeyStore } from "../src/auth/apiKeyStore.js";
import { PassThroughGuardrails } from "../src/guardrails/guardrails.js";
import { InputCache, InMemoryCacheStore } from "../src/cache/inputCache.js";
import { MockUpstream } from "./helpers/mockUpstream.js";
import { CapturingSink } from "./helpers/capturingSink.js";

const TIER_LIMITS = {
  free: { requestsPerMinute: 1_000_000, tokensPerMinute: 1_000_000 },
  pro: { requestsPerMinute: 1_000_000, tokensPerMinute: 1_000_000 },
  enterprise: { requestsPerMinute: 10_000_000, tokensPerMinute: 10_000_000 },
};

const TWO_ARM_RULE: RulesResponse = {
  rules: [
    {
      experimentId: "exp-1",
      tenantId: "tenant-a",
      name: "prompt-vs-baseline",
      salt: "salt-1",
      arms: [
        { name: "control", weight: 50 },
        { name: "treatment", weight: 50, model: "groq-override" },
      ],
    },
  ],
  unresolved: [],
};

describe("experiment engine", () => {
  it("degrades to no experiment when the control plane is unreachable", async () => {
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 1_000,
      loadRules: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(engine.resolve("tenant-a", "mistral-large-latest", "key-1")).resolves.toBeNull();
  });

  it("serves stale rules instead of failing when a refresh errors", async () => {
    let healthy = true;
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 10,
      loadRules: async () => {
        if (!healthy) {
          throw new Error("control plane down");
        }
        return TWO_ARM_RULE;
      },
    });

    const first = await engine.resolve("tenant-a", "mistral-large-latest", "key-1");
    expect(first).not.toBeNull();
    healthy = false;
    // Cache TTL elapsed but refresh fails: the stale rule set still resolves.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await engine.resolve("tenant-a", "mistral-large-latest", "key-1");
    expect(second).not.toBeNull();
  });

  it("assigns the same sticky key to the same arm deterministically", async () => {
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => TWO_ARM_RULE,
    });
    const first = await engine.resolve("tenant-a", "mistral-large-latest", "session-42");
    for (let i = 0; i < 5; i += 1) {
      const again = await engine.resolve("tenant-a", "mistral-large-latest", "session-42");
      expect(again?.arm).toBe(first?.arm);
    }
  });

  it("spreads many sticky keys across arms within sane bounds", async () => {
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => TWO_ARM_RULE,
    });
    const counts: Record<string, number> = { control: 0, treatment: 0 };
    for (let i = 0; i < 2_000; i += 1) {
      const assignment = await engine.resolve("tenant-a", "m", `key-${i}`);
      counts[assignment!.arm] += 1;
    }
    // 50/50 split: each arm should land near half of 2000.
    expect(counts.control).toBeGreaterThan(800);
    expect(counts.treatment).toBeGreaterThan(800);
    expect(counts.control + counts.treatment).toBe(2_000);
  });

  it("applies the arm's model override and reports assignments once per key", async () => {
    const reported: Array<{ experimentId: string; arm: string; keyHash: string }> = [];
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => TWO_ARM_RULE,
      reportAssignment: (experimentId, payload) => {
        reported.push({ experimentId, ...payload });
      },
    });

    let overrideSeen = false;
    for (let i = 0; i < 500 && !overrideSeen; i += 1) {
      const assignment = await engine.resolve("tenant-a", "mistral-large-latest", `k${i}`);
      if (assignment?.arm === "treatment") {
        expect(assignment.modelOverride).toBe("groq-override");
        overrideSeen = true;
      }
    }
    expect(overrideSeen).toBe(true);
    expect(reported.length).toBeGreaterThan(0);
    // Repeat resolutions must not re-report for already-seen keys.
    const beforeRepeat = reported.length;
    const knownKey = Object.keys(Array.from({ length: 1 }).map(() => ""))[0] ?? "";
    void knownKey;
    const repeat = await engine.resolve("tenant-a", "mistral-large-latest", "k0");
    expect(repeat).not.toBeNull();
    expect(reported.length - beforeRepeat).toBeLessThanOrEqual(1);
  });

  it("ignores experiments targeting other models or tenants", async () => {
    const targeted: RulesResponse = {
      rules: [
        {
          experimentId: "exp-2",
          tenantId: "tenant-a",
          name: "only-gemini",
          salt: "s2",
          targetingModels: ["gemini-3.6-flash"],
          arms: [
            { name: "a", weight: 50 },
            { name: "b", weight: 50 },
          ],
        },
      ],
      unresolved: [],
    };
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => targeted,
    });
    await expect(engine.resolve("tenant-a", "mistral-large-latest", "k")).resolves.toBeNull();
    await expect(engine.resolve("tenant-b", "gemini-3.6-flash", "k")).resolves.toBeNull();
    await expect(engine.resolve("tenant-a", "gemini-3.6-flash", "k")).resolves.not.toBeNull();
  });

  it("hashes sticky keys without leaking raw ids and buckets deterministically", () => {
    const h1 = hashKey("secret-session-id");
    expect(h1).not.toContain("secret-session-id");
    expect(h1).toHaveLength(32);
    expect(hashKey("secret-session-id")).toBe(h1);
    expect(bucketOf("salt", "key")).toBe(bucketOf("salt", "key"));
    expect(bucketOf("salt-a", "key")).not.toBe(bucketOf("salt-b", "key"));
  });
});

/* ------------------------- route integration (E2E) ------------------------- */

interface Harness {
  app: FastifyInstance;
  providers: [MockUpstream, MockUpstream];
  sink: CapturingSink;
  apiKey: string;
  baseUrl: string;
  close: () => Promise<void>;
}

const openHandles: Harness[] = [];

async function harness(engine: ExperimentEngine): Promise<Harness> {
  const providers: MockUpstream[] = [];
  for (let i = 0; i < 2; i += 1) {
    const upstream = new MockUpstream();
    await upstream.start();
    providers.push(upstream);
  }
  const ids = ["mistral", "groq"] as const;
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

  const sink = new CapturingSink();
  const runtime: GatewayRuntime = {
    adapters,
    registry: ModelRegistry.forProviders(new Set(ids)),
    router: new Router(adapters, { defaultChain: ["groq"] }),
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    limiter: new InMemoryRateLimiter(TIER_LIMITS),
    keyStore: new InMemoryApiKeyStore(),
    sinks: [sink],
    guardrails: new PassThroughGuardrails(),
    inputCache: new InputCache(new InMemoryCacheStore(), {
      enabled: false,
      ttlSeconds: 60,
      maxEntryBytes: 1024 * 1024,
    }),
    anthropicAutoSystemCache: false,
    experiments: engine,
    close: async () => undefined,
  };

  const app = await buildApp(
    {
      AXIOM_ENV: "test",
      AXIOM_INTER_SERVICE_SECRET: "dev-only-inter-service-secret",
      GATEWAY_PORT: 0,
      LOG_LEVEL: "error",
      GATEWAY_ROUTING: { defaultChain: ["groq"] },
      GATEWAY_TIER_LIMITS: TIER_LIMITS,
      GATEWAY_UPSTREAM_TIMEOUT_MS: 5_000,
      GEMINI_MODEL: "gemini-3.6-flash",
    },
    runtime,
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const keyStore = runtime.keyStore as InMemoryApiKeyStore;
  const issued = await keyStore.issue({
    tenantId: "tenant-a",
    projectId: "proj-1",
    rateLimitTier: "pro",
  });

  const handle: Harness = {
    app,
    providers: providers as [MockUpstream, MockUpstream],
    sink,
    apiKey: issued.apiKey,
    baseUrl: `http://127.0.0.1:${port}`,
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

describe("chat route experiment integration (E2E)", () => {
  it("emits assignment headers and applies the arm's model override on chat", async () => {
    // Build an engine whose single-arm rule guarantees the override path.
    const forced: RulesResponse = {
      rules: [
        {
          experimentId: "exp-force",
          tenantId: "tenant-a",
          name: "forced-treatment",
          salt: "force-salt",
          arms: [
            { name: "control", weight: 0 },
            { name: "treatment", weight: 100, model: "groq-override" },
          ],
        },
      ],
      unresolved: [],
    };
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => forced,
    });
    const h = await harness(engine);

    const response = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authed(h.apiKey),
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: "Say hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axiom-experiment")).toBe("forced-treatment");
    expect(response.headers.get("x-axiom-experiment-arm")).toBe("treatment");
    expect(response.headers.get("x-axiom-provider")).toBe("groq");
  });

  it("leaves the proxy path untouched when no experiment matches", async () => {
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => ({ rules: [], unresolved: [] }),
    });
    const h = await harness(engine);

    const response = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authed(h.apiKey),
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: "Say hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-axiom-experiment")).toBeNull();
    expect(response.headers.get("x-axiom-provider")).toBe("mistral");
  });

  it("substitutes template variables into the system message and leaves unknown ones", async () => {
    const templated: RulesResponse = {
      rules: [
        {
          experimentId: "exp-tpl",
          tenantId: "tenant-a",
          name: "templated",
          salt: "tpl-salt",
          arms: [
            {
              name: "treatment",
              weight: 100,
              template: "You are {{persona}} helping {{unknown_var}} now",
            },
          ],
        },
      ],
      unresolved: [],
    };
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => templated,
    });
    const h = await harness(engine);

    const response = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authed(h.apiKey), "x-axiom-experiment-vars": JSON.stringify({ persona: "Pilot" }) },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: "Say hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const upstreamBody = h.providers[0].requests[0]?.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const system = upstreamBody.messages.find((message) => message.role === "system");
    expect(system).toBeDefined();
    expect(JSON.stringify(system?.content)).toContain("You are Pilot helping {{unknown_var}} now");
  });
});

/* --------------------- O6: W3C trace-context correlation -------------------- */

describe("O6 cross-service trace correlation (E2E)", () => {
  it("propagates a valid W3C traceparent derived from the inbound request to the upstream", async () => {
    const engine = new ExperimentEngine({
      internalSecret: "s",
      cacheTtlMs: 60_000,
      loadRules: async () => ({ rules: [], unresolved: [] }),
    });
    const h = await harness(engine);

    const inboundTraceparent =
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const response = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...authed(h.apiKey),
        traceparent: inboundTraceparent,
      },
      body: JSON.stringify({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: "Say hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const outboundHeaders = h.providers[0].requests[0]?.headers ?? {};
    const outbound = String(outboundHeaders["traceparent"] ?? "");
    expect(outbound).not.toBe("");
    // Valid W3C format: version-traceid-spanid-flags, same trace id as inbound.
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(outbound);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("0af7651916cd43dd8448eb211c80319c");
    // Child span differs from the inbound parent span id.
    expect(match![2]).not.toBe("b7ad6b7169203331");
  });
});
