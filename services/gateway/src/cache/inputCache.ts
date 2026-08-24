/**
 * Gateway input cache (exact-match, tenant-scoped).
 *
 * Identical requests (same tenant + model + messages + sampling params)
 * are served from a stored response instead of re-hitting upstreams. This
 * is deliberately provider-agnostic — it sits above the adapters, so it
 * works identically for the OpenAI-compatible family and Anthropic.
 *
 * Guarantees:
 *  - Tenant isolation: keys hash the tenant id; cross-tenant hits are
 *    impossible even for byte-identical payloads.
 *  - Bounded memory: entries larger than `maxEntryBytes` are never stored.
 *  - TTL semantics via Redis SETEX or an in-memory mirror for dev/tests.
 *  - Stampede protection (`dedupe`): concurrent identical non-streaming
 *    misses share one in-flight upstream call.
 */

import { createHash } from "node:crypto";

import type { Redis as RedisClient } from "ioredis";

import type { ChatCompletionRequest } from "@axiom-ai/core";

export interface InputCacheOptions {
  enabled: boolean;
  ttlSeconds: number;
  maxEntryBytes: number;
}

export interface CachedUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CacheEnvelope {
  /** Provider that produced the response (surfaced on replay). */
  provider: string;
  model: string;
  status: number;
  contentType: string;
  body: string;
  streamed: boolean;
  usage: CachedUsage;
  createdAt: number;
}

export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1_000 });
  }
}

export class RedisCacheStore implements CacheStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly fallback: InMemoryCacheStore,
  ) {}

  async get(key: string): Promise<string | undefined> {
    try {
      return (await this.redis.get(key)) ?? undefined;
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, "EX", Math.max(1, Math.floor(ttlSeconds)));
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }
}

/**
 * Deterministic JSON serialization with recursively sorted object keys so
 * semantically identical payloads hash identically regardless of client
 * key ordering (e.g. tool JSON Schemas).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Fields that participate in the cache identity of a request. */
function identityOf(request: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    tools: request.tools ?? null,
    temperature: request.temperature ?? null,
    topP: request.topP ?? null,
    maxTokens: request.maxTokens ?? null,
    stopSequences: request.stopSequences ?? null,
    promptCacheKey: request.promptCacheKey ?? null,
  };
}

export class InputCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  private readonly cacheStore: CacheStore;

  constructor(
    store: CacheStore,
    readonly options: InputCacheOptions,
  ) {
    this.cacheStore = store;
  }

  /**
   * Stable, tenant-scoped cache key. The tenant id is part of the hashed
   * payload so key material alone never leaks tenant groupings.
   */
  keyFor(tenantId: string, request: ChatCompletionRequest): string {
    const digest = createHash("sha256")
      .update(
        stableStringify({
          v: 2,
          tenantId,
          ...identityOf(request),
        }),
      )
      .digest("hex");
    return `icache:${digest}`;
  }

  async lookup(key: string): Promise<CacheEnvelope | undefined> {
    if (!this.options.enabled) {
      return undefined;
    }
    const raw = await this.cacheStore.get(key);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as CacheEnvelope;
    } catch {
      return undefined;
    }
  }

  /** Stores only when enabled and within the configured size budget. */
  async store(key: string, envelope: Omit<CacheEnvelope, "createdAt">): Promise<boolean> {
    if (!this.options.enabled) {
      return false;
    }
    const payload = JSON.stringify({ ...envelope, createdAt: Date.now() });
    if (Buffer.byteLength(payload, "utf8") > this.options.maxEntryBytes) {
      return false;
    }
    await this.cacheStore.set(key, payload, this.options.ttlSeconds);
    return true;
  }

  /**
   * Collapses concurrent identical loads into one execution. Followers
   * receive the leader's result flagged `deduped: true`.
   */
  async dedupe<T>(
    key: string,
    factory: () => Promise<T>,
  ): Promise<{ value: T; deduped: boolean }> {
    if (!this.options.enabled) {
      return { value: await factory(), deduped: false };
    }
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return { value: (await existing) as T, deduped: true };
    }
    const promise = factory().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    // Rejections are shared with followers by design; `finally` above
    // clears the in-flight entry so failures are retried upstream.
    return { value: await promise, deduped: false };
  }
}
