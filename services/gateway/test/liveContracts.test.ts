/**
 * Live provider contract tests (ADR 0006).
 *
 * Skipped unless RUN_LIVE_CONTRACT_TESTS=1 — CI runs these nightly, PRs run
 * the fixture-based suites. Each test exercises one real upstream end to
 * end through a gateway instance wired with only that provider.
 */

import { describe, expect, it } from "vitest";
import type { ProviderId } from "@tanvir1971/core";

import type { ProviderAdapter } from "../src/providers/types.js";

import { buildApp } from "../src/app.js";
import { createGatewayConfig } from "../src/config.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { OpenAiCompatibleAdapter } from "../src/providers/openaiCompatible.js";
import { ModelRegistry } from "../src/providers/registry.js";
import { Router } from "../src/router/router.js";
import { CircuitBreaker } from "../src/router/circuitBreaker.js";
import { InMemoryRateLimiter } from "../src/ratelimit/rateLimiter.js";
import { InMemoryApiKeyStore } from "../src/auth/apiKeyStore.js";
import { PassThroughGuardrails } from "../src/guardrails/guardrails.js";
import { CapturingSink } from "./helpers/capturingSink.js";
import { InMemoryCacheStore, InputCache } from "../src/cache/inputCache.js";

const RUN_LIVE = process.env.RUN_LIVE_CONTRACT_TESTS === "1";
const TIMEOUT_MS = 60_000;

interface LiveTarget {
  id: ProviderId;
  envKey: string;
  model: string;
}

const TARGETS: readonly LiveTarget[] = [
  { id: "gemini", envKey: "GEMINI_API_KEY", model: "gemini-3.6-flash" },
  { id: "groq", envKey: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  { id: "mistral", envKey: "MISTRAL_API_KEY", model: "mistral-large-latest" },
  { id: "siliconflow", envKey: "SILICONFLOW_API_KEY", model: "deepseek-ai/DeepSeek-V3" },
  { id: "nvidia-nim", envKey: "NVIDIA_NIM_API_KEY", model: "meta/llama-3.1-70b-instruct" },
];

/**
 * Environmental failures (invalid/expired provider keys, free-tier quota)
 * are configuration problems, not gateway defects — skip with context so
 * nightly runs stay actionable without going red on infra drift.
 */
async function skipIfEnvironmental(responseStatus: number, bodyText: string): Promise<boolean> {
  if ([401, 403, 429, 502].includes(responseStatus)) {
    const environmental =
      /api key is invalid/i.test(bodyText) ||
      /does not exist or you do not have access/i.test(bodyText) ||
      /exceeded your current quota/i.test(bodyText) ||
      /free_tier_requests/i.test(bodyText) ||
      /billing/i.test(bodyText);
    if (environmental) {
      return true;
    }
  }
  return false;
}

describe.runIf(RUN_LIVE)("live provider contracts", () => {
  for (const target of TARGETS) {
    describe(`${target.id} (${target.model})`, () => {
      it("completes a chat request and meters reported usage", async () => {
        const key = process.env[target.envKey];
        if (key === undefined || key === "") {
          return; // provider not configured in this environment
        }

        const adapters = new Map<string, ProviderAdapter>([
          [
            target.id,
            new OpenAiCompatibleAdapter({ id: target.id, baseUrl: baseUrlOf(target.id), apiKey: key, timeoutMs: 45_000 }),
          ],
        ]);
        const sink = new CapturingSink();
        const keyStore = new InMemoryApiKeyStore();
        const runtime: GatewayRuntime = {
          adapters,
          registry: ModelRegistry.forProviders(new Set([target.id])),
          router: new Router(adapters, { defaultChain: [] }),
          breaker: new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5_000 }),
          limiter: new InMemoryRateLimiter({
            free: { requestsPerMinute: 10, tokensPerMinute: 100_000 },
            pro: { requestsPerMinute: 1_000, tokensPerMinute: 1_000_000 },
            enterprise: { requestsPerMinute: 10_000, tokensPerMinute: 10_000_000 },
          }),
          keyStore,
          sinks: [sink],
          guardrails: new PassThroughGuardrails(),
          inputCache: new InputCache(new InMemoryCacheStore(), {
            enabled: false,
            ttlSeconds: 60,
            maxEntryBytes: 1024 * 1024,
          }),
          anthropicAutoSystemCache: false,
          close: async () => undefined,
        };

        const app = await buildApp(
          createGatewayConfig({
            AXIOM_ENV: "test",
            AXIOM_INTER_SERVICE_SECRET: "live-contract-test-secret-not-used",
            GATEWAY_PORT: 1,
            LOG_LEVEL: "error",
          }),
          runtime,
        );
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const issued = await keyStore.issue({
          tenantId: "live-test",
          projectId: "contracts",
          rateLimitTier: "pro",
        });

        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${issued.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: target.model,
              messages: [{ role: "user", content: "Reply with exactly: pong" }],
              max_tokens: 512,
            }),
          });
          if (response.status !== 200) {
            const text = await response.text();
            if (await skipIfEnvironmental(response.status, text)) {
              console.warn(`[live:${target.id}] complete skipped: ${text.slice(0, 120)}`);
              return;
            }
            expect(response.status).toBe(200);
            return;
          }
          const body = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: Record<string, number>;
          };
          expect(body.choices?.[0]?.message?.content).toBeTruthy();

          const record = sink.records.at(-1);
          expect(record?.provider).toBe(target.id);
          if (body.usage !== undefined) {
            expect(record?.promptTokens).toBe(body.usage.prompt_tokens);
            expect(record?.completionTokens).toBe(body.usage.completion_tokens);
          }
        } finally {
          await app.close();
        }
      }, TIMEOUT_MS);

      it("streams SSE completions", async () => {
        const key = process.env[target.envKey];
        if (key === undefined || key === "") {
          return;
        }

        const adapters = new Map<string, ProviderAdapter>([
          [
            target.id,
            new OpenAiCompatibleAdapter({ id: target.id, baseUrl: baseUrlOf(target.id), apiKey: key, timeoutMs: 45_000 }),
          ],
        ]);
        const keyStore = new InMemoryApiKeyStore();
        const runtime: GatewayRuntime = {
          adapters,
          registry: ModelRegistry.forProviders(new Set([target.id])),
          router: new Router(adapters, { defaultChain: [] }),
          breaker: new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5_000 }),
          limiter: new InMemoryRateLimiter({
            free: { requestsPerMinute: 10, tokensPerMinute: 100_000 },
            pro: { requestsPerMinute: 1_000, tokensPerMinute: 1_000_000 },
            enterprise: { requestsPerMinute: 10_000, tokensPerMinute: 10_000_000 },
          }),
          keyStore,
          sinks: [new CapturingSink()],
          guardrails: new PassThroughGuardrails(),
          inputCache: new InputCache(new InMemoryCacheStore(), {
            enabled: false,
            ttlSeconds: 60,
            maxEntryBytes: 1024 * 1024,
          }),
          anthropicAutoSystemCache: false,
          close: async () => undefined,
        };
        const app = await buildApp(
          createGatewayConfig({
            AXIOM_ENV: "test",
            AXIOM_INTER_SERVICE_SECRET: "live-contract-test-secret-not-used",
            GATEWAY_PORT: 1,
            LOG_LEVEL: "error",
          }),
          runtime,
        );
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const issued = await keyStore.issue({
          tenantId: "live-test",
          projectId: "contracts-stream",
          rateLimitTier: "pro",
        });

        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${issued.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: target.model,
              messages: [{ role: "user", content: "Count from 1 to 5." }],
              stream: true,
              max_tokens: 512,
            }),
          });
          if (response.status !== 200) {
            const text = await response.text();
            if (await skipIfEnvironmental(response.status, text)) {
              console.warn(`[live:${target.id}] stream skipped: ${text.slice(0, 120)}`);
              return;
            }
            expect(response.status).toBe(200);
            return;
          }
          expect(response.headers.get("content-type")).toContain("text/event-stream");

          const raw = await response.text();
          expect(raw.length).toBeGreaterThan(0);
          expect(raw).toContain('"delta"');
        } finally {
          await app.close();
        }
      }, TIMEOUT_MS);
    });
  }
});

function baseUrlOf(id: ProviderId): string {
  switch (id) {
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "siliconflow":
      return "https://api.siliconflow.cn/v1";
    case "nvidia-nim":
      return "https://integrate.api.nvidia.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
    default:
      throw new Error(`no live endpoint for ${id}`);
  }
}
