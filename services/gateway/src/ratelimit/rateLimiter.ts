/**
 * Rate limiting (G4).
 *
 * - RPM: sliding-window log over a Redis ZSET (or in-memory array mirror)
 *   — exact counts, no boundary bursts of fixed windows.
 * - TPM: soft token quota via an incrementing counter with 60s TTL; checked
 *   before the request and updated after usage is known.
 */

import type { Redis } from "ioredis";

import type { TenantContext } from "@axiom-ai/core";

import type { TierLimit } from "./tierLimits.js";

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets (oldest entry + window). */
  resetAtSeconds: number;
}

export type { TierLimit };

export interface RateLimiter {
  consume(tenant: TenantContext, nowMs?: number): Promise<RateLimitDecision>;
  recordTokens(tenant: TenantContext, tokens: number): Promise<void>;
  tokenBudget(tenant: TenantContext): Promise<number>;
}

const WINDOW_MS = 60_000;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly tokens = new Map<string, { count: number; windowStart: number }>();

  constructor(protected readonly limits: Record<TenantContext["rateLimitTier"], TierLimit>) {}

  async consume(tenant: TenantContext, nowMs: number = Date.now()): Promise<RateLimitDecision> {
    const limit = this.limits[tenant.rateLimitTier].requestsPerMinute;
    const key = tenant.tenantId;
    const entries = (this.windows.get(key) ?? []).filter((ts) => nowMs - ts < WINDOW_MS);
    const allowed = entries.length < limit;
    if (allowed) {
      entries.push(nowMs);
    }
    this.windows.set(key, entries);
    const oldest = entries[0];
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - entries.length),
      resetAtSeconds: Math.floor(((oldest ?? nowMs) + WINDOW_MS) / 1000),
    };
  }

  async recordTokens(tenant: TenantContext, tokens: number): Promise<void> {
    const key = `tpm:${tenant.tenantId}`;
    const current = this.tokens.get(key);
    const now = Date.now();
    if (current === undefined || now - current.windowStart >= WINDOW_MS) {
      this.tokens.set(key, { count: tokens, windowStart: now });
      return;
    }
    current.count += tokens;
  }

  async tokenBudget(tenant: TenantContext): Promise<number> {
    const current = this.tokens.get(`tpm:${tenant.tenantId}`);
    const used =
      current !== undefined && Date.now() - current.windowStart < WINDOW_MS ? current.count : 0;
    return Math.max(0, this.limits[tenant.rateLimitTier].tokensPerMinute - used);
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limits: Record<TenantContext["rateLimitTier"], TierLimit>,
    /** Mirror used only if Redis is unreachable mid-request. */
    private readonly fallback = new InMemoryRateLimiter(limits),
  ) {}

  async consume(tenant: TenantContext, nowMs: number = Date.now()): Promise<RateLimitDecision> {
    const limit = this.limits[tenant.rateLimitTier].requestsPerMinute;
    const key = `rl:{${tenant.tenantId}}`;
    const windowStart = nowMs - WINDOW_MS;

    let results: Array<[Error | null, unknown]> | null;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zcard(key);
      pipeline.zrange(key, 0, 0, "WITHSCORES");
      results = await pipeline.exec();
    } catch {
      return this.fallback.consume(tenant, nowMs);
    }
    if (results === null) {
      return this.fallback.consume(tenant, nowMs);
    }

    const count = Number(results[1]?.[1] ?? 0);
    const oldestScoreRaw = results[2]?.[1];
    let oldestScore: number | undefined;
    if (Array.isArray(oldestScoreRaw) && oldestScoreRaw.length === 2) {
      oldestScore = Number(oldestScoreRaw[1]);
    }

    if (count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAtSeconds: Math.floor(((oldestScore ?? nowMs) + WINDOW_MS) / 1000),
      };
    }

    const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;
    const added = await this.redis.zadd(key, nowMs, member);
    // Re-check after add to stay correct under concurrent issuers.
    const newCount = await this.redis.zcard(key);
    if (added === 1 && newCount > limit) {
      await this.redis.zrem(key, member);
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAtSeconds: Math.floor((nowMs + WINDOW_MS) / 1000),
      };
    }
    await this.redis.pexpire(key, WINDOW_MS * 2);

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - newCount),
      resetAtSeconds: Math.floor(((oldestScore ?? nowMs) + WINDOW_MS) / 1000),
    };
  }

  async recordTokens(tenant: TenantContext, tokens: number): Promise<void> {
    const key = `tpm:{${tenant.tenantId}}`;
    const count = await this.redis.incrby(key, tokens);
    if (count === tokens) {
      await this.redis.pexpire(key, WINDOW_MS * 2);
    }
  }

  async tokenBudget(tenant: TenantContext): Promise<number> {
    const raw = await this.redis.get(`tpm:{${tenant.tenantId}}`);
    const used = Number(raw ?? 0);
    const limit = this.limits[tenant.rateLimitTier].tokensPerMinute;
    return Math.max(0, limit - used);
  }
}
