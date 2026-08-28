/**
 * Gateway runtime: wires providers, routing, limiting, auth storage,
 * guardrails, and metering into one injectable bundle. Everything is built
 * from configuration so tests can substitute fakes wholesale.
 */

import { Redis as RedisClientClass } from "ioredis";
import type { Redis as RedisClient } from "ioredis";

import type { ProviderAdapter } from "./providers/types.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { buildOpenAiCompatibleProviders } from "./providers/endpoints.js";
import { ModelRegistry } from "./providers/registry.js";
import { Router, type RoutingConfig } from "./router/router.js";
import { CircuitBreaker } from "./router/circuitBreaker.js";
import {
  InMemoryRateLimiter,
  RedisRateLimiter,
  type RateLimiter,
} from "./ratelimit/rateLimiter.js";
import type { TierLimit } from "./ratelimit/tierLimits.js";
import { InMemoryApiKeyStore, type ApiKeyStore } from "./auth/apiKeyStore.js";
import { PostgresApiKeyStore } from "./auth/postgresApiKeyStore.js";
import {
  ConsoleMeterSink,
  ClickHouseMeterSink,
  type MeterSink,
} from "./metering/sinks.js";
import {
  PassThroughGuardrails,
  createDefaultGuardrails,
  type GuardrailHook,
} from "./guardrails/guardrails.js";
import {
  InMemoryCacheStore,
  InputCache,
  RedisCacheStore,
} from "./cache/inputCache.js";
import { ExperimentEngine } from "./experiments/engine.js";

import type { GatewayConfig } from "./config.js";

export interface GatewayRuntime {
  adapters: ReadonlyMap<string, ProviderAdapter>;
  registry: ModelRegistry;
  router: Router;
  breaker: CircuitBreaker;
  limiter: RateLimiter;
  keyStore: ApiKeyStore;
  sinks: MeterSink[];
  guardrails: GuardrailHook;
  inputCache: InputCache;
  anthropicAutoSystemCache: boolean;
  /** A/B assignment engine; absent when no control plane is configured. */
  experiments?: ExperimentEngine;
  redis?: RedisClient;
  close: () => Promise<void>;
}

function tierLimitsOf(config: GatewayConfig): Record<"free" | "pro" | "enterprise", TierLimit> {
  return config.GATEWAY_TIER_LIMITS;
}

export async function buildRuntime(config: GatewayConfig): Promise<GatewayRuntime> {
  const keys: Record<string, string | undefined> = {
    OPENAI_API_KEY: config.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: config.GEMINI_API_KEY,
    GROQ_API_KEY: config.GROQ_API_KEY,
    MISTRAL_API_KEY: config.MISTRAL_API_KEY,
    SILICONFLOW_API_KEY: config.SILICONFLOW_API_KEY,
    NVIDIA_NIM_API_KEY: config.NVIDIA_NIM_API_KEY,
  };

  const adapters = new Map<string, ProviderAdapter>();
  for (const adapter of buildOpenAiCompatibleProviders(keys, config.GATEWAY_UPSTREAM_TIMEOUT_MS)) {
    adapters.set(adapter.id, adapter);
  }
  const anthropic = new AnthropicAdapter(
    keys.ANTHROPIC_API_KEY,
    config.GATEWAY_UPSTREAM_TIMEOUT_MS,
    fetch,
    config.GATEWAY_ANTHROPIC_AUTO_SYSTEM_CACHE,
  );
  if (anthropic.isConfigured()) {
    adapters.set(anthropic.id, anthropic);
  }

  const enabledProviders = new Set(
    [...adapters.values()].filter((adapter) => adapter.isConfigured()).map((adapter) => adapter.id),
  );
  const registry = ModelRegistry.forProviders(enabledProviders);

  const routing: RoutingConfig = config.GATEWAY_ROUTING;
  const router = new Router(adapters, routing);

  const breaker = new CircuitBreaker({
    failureThreshold: config.GATEWAY_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: config.GATEWAY_BREAKER_COOLDOWN_MS,
  });

  let limiter: RateLimiter;
  let redis: RedisClient | undefined;
  if (config.REDIS_PRIMARY_URL !== undefined) {
    const client: RedisClient = new RedisClientClass(
      config.REDIS_PRIMARY_URL,
      { lazyConnect: true, maxRetriesPerRequest: 2 },
    );
    redis = client;
    client.on("error", () => {
      // Errors surface through limiter fallbacks; keep process alive.
    });
    await client.connect().catch(() => undefined);
    limiter = new RedisRateLimiter(client, tierLimitsOf(config));
  } else {
    limiter = new InMemoryRateLimiter(tierLimitsOf(config));
  }

  const cacheOptions = {
    enabled: config.GATEWAY_INPUT_CACHE.enabled,
    ttlSeconds: config.GATEWAY_INPUT_CACHE.ttlSeconds,
    maxEntryBytes: config.GATEWAY_INPUT_CACHE.maxEntryBytes,
  };
  const inputCache = new InputCache(
    redis !== undefined
      ? new RedisCacheStore(redis, new InMemoryCacheStore())
      : new InMemoryCacheStore(),
    cacheOptions,
  );

  let keyStore: ApiKeyStore = new InMemoryApiKeyStore();
  if (config.POSTGRES_DB_URI !== undefined) {
    const pgStore = new PostgresApiKeyStore(config.POSTGRES_DB_URI);
    try {
      await pgStore.migrate();
      keyStore = pgStore;
    } catch {
      // Postgres unreachable at boot: fall back so dev keeps working.
      keyStore = new InMemoryApiKeyStore();
    }
  }

  const sinks: MeterSink[] =
    config.CLICKHOUSE_NODES !== undefined && config.CLICKHOUSE_NODES.length > 0
      ? [new ClickHouseMeterSink(config.CLICKHOUSE_NODES)]
      : [new ConsoleMeterSink()];

  const guardrailsConfig = config.GATEWAY_GUARDRAILS;
  const guardrails: GuardrailHook =
    guardrailsConfig !== undefined
      ? (guardrailsConfig.enabled
          ? createDefaultGuardrails({
              piiMode: guardrailsConfig.piiMode,
              policyEnabled: guardrailsConfig.policyEnabled,
              bannedKeywords: guardrailsConfig.bannedKeywords,
            })
          : new PassThroughGuardrails())
      : createDefaultGuardrails();

  const experiments =
    config.OPS_CONTROL_PLANE_URL !== undefined
      ? new ExperimentEngine({
          controlPlaneUrl: config.OPS_CONTROL_PLANE_URL,
          internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
          cacheTtlMs: config.GATEWAY_EXPERIMENTS_CACHE_TTL_MS,
        })
      : undefined;

  return {
    adapters,
    registry,
    router,
    breaker,
    limiter,
    keyStore,
    sinks,
    guardrails,
    inputCache,
    anthropicAutoSystemCache: config.GATEWAY_ANTHROPIC_AUTO_SYSTEM_CACHE,
    experiments,
    redis,
    close: async () => {
      await Promise.allSettled(sinks.map((sink) => sink.flush()));
      if (redis !== undefined) {
        redis.disconnect();
      }
      await keyStore.close?.();
    },
  };
}

/** Seeds a dev tenant key when running without persistent storage. */
export async function seedDevKeyIfMemoryStore(runtime: GatewayRuntime): Promise<void> {
  if (runtime.keyStore instanceof InMemoryApiKeyStore) {
    await runtime.keyStore.issue({
      tenantId: "tenant-dev",
      projectId: "project-dev",
      rateLimitTier: "pro",
    });
  }
}
