/**
 * Webhook fan-out (A5). Deliveries are signed (HMAC-SHA256 via
 * @axiom-ai/core), retried with exponential backoff + jitter over BullMQ,
 * and dead-lettered after the final attempt for operator replay.
 *
 * Delivery semantics: at-least-once. Receivers dedupe on the
 * `axiom-event-id` header to reach exactly-once observation.
 */

import type { Redis as RedisClient } from "ioredis";

import { signPayload, SIGNATURE_HEADER } from "@axiom-ai/core";

import { QUEUE_NAMES } from "../queues.js";

export interface WebhookDeliveryJob {
  /** Idempotency key shared by every retry of this event. */
  eventId: string;
  eventType: string;
  tenantId: string;
  endpointUrl: string;
  /** Per-endpoint secret used for HMAC signing. */
  secret: string;
  bodyJson: string;
  maxAttempts: number;
}

/** Pure backoff decision — unit-tested. Base 1s, cap 60s, ±25% jitter. */
export function jitteredBackoffMs(attemptsMade: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** attemptsMade);
  const jitter = 0.75 + rand() * 0.5;
  return Math.floor(base * jitter);
}

export interface DispatchOutcome {
  delivered: boolean;
  status?: number;
  deadLettered: boolean;
  error?: string;
}

export class WebhookDispatcher {
  constructor(private readonly redis: RedisClient) {}

  async deliver(jobData: WebhookDeliveryJob, attemptsMadeSoFar: number): Promise<DispatchOutcome> {
    const timestamp = Math.floor(Date.now() / 1000);
    const { headerValue } = signPayload(jobData.secret, jobData.bodyJson, { timestamp });
    try {
      const response = await fetch(jobData.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: headerValue,
          "axiom-event-id": jobData.eventId,
          "axiom-event-type": jobData.eventType,
          "axiom-tenant-id": jobData.tenantId,
          connection: "close",
        },
        body: jobData.bodyJson,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        return { delivered: true, status: response.status, deadLettered: false };
      }
      return await this.handleFailure(jobData, attemptsMadeSoFar, `HTTP ${response.status}`, response.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.handleFailure(jobData, attemptsMadeSoFar, message);
    }
  }

  private async handleFailure(
    jobData: WebhookDeliveryJob,
    attemptsMadeSoFar: number,
    error: string,
    status?: number,
  ): Promise<DispatchOutcome> {
    const nextAttempt = attemptsMadeSoFar + 1;
    if (nextAttempt >= jobData.maxAttempts) {
      await this.deadLetter(jobData, error);
      return { delivered: false, status, deadLettered: true, error };
    }
    // Throw inside the BullMQ processor triggers a scheduled retry using
    // the queue's exponential-backoff policy.
    throw new Error(error);
  }

  private async deadLetter(jobData: WebhookDeliveryJob, error: string): Promise<void> {
    await this.redis.xadd(
      `${QUEUE_NAMES.webhookDeadLetter}:stream`,
      "*",
      "payload",
      JSON.stringify({ ...jobData, lastError: error, deadLetteredAt: new Date().toISOString() }),
    );
  }
}

/** Reads the DLQ stream for operator replay (used by scripts/webhook-replay). */
export async function readDeadLetters(
  redis: RedisClient,
  limit = 100,
): Promise<Array<WebhookDeliveryJob & { lastError: string; deadLetteredAt: string }>> {
  const entries = await redis.xrange(`${QUEUE_NAMES.webhookDeadLetter}:stream`, "-", "+", "COUNT", limit);
  return entries
    .map((entry) => {
      const fields = entry[1];
      const payloadIndex = fields.indexOf("payload");
      if (payloadIndex === -1) {
        return undefined;
      }
      const payload = fields[payloadIndex + 1];
      if (payload === undefined) {
        return undefined;
      }
      try {
        return JSON.parse(payload) as WebhookDeliveryJob & {
          lastError: string;
          deadLetteredAt: string;
        };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is WebhookDeliveryJob & { lastError: string; deadLetteredAt: string } => item !== undefined);
}
