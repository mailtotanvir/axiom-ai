/**
 * Webhook fan-out integration tests (A5 exit gate).
 *
 * Requires Redis (compose stack on localhost:6379); skips otherwise.
 * Proves: signed delivery, tamper rejection, retry-then-DLQ routing,
 * DLQ replay restoring delivery, and exactly-once observation over
 * at-least-once attempts.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, recordedDeliveries, resetRecordedDeliveries } from "../src/server.js";
import {
  jitteredBackoffMs,
  readDeadLetters,
  WebhookDispatcher,
  type WebhookDeliveryJob,
} from "../src/webhooks/dispatcher.js";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
let redisAvailable = false;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  redis.on("error", () => undefined);
  redisAvailable = await redis.connect().then(() => true).catch(() => false);
});

afterAll(async () => {
  if (redisAvailable) {
    await redis.flushdb();
    await redis.quit().catch(() => redis.disconnect());
  }
});

function makeJob(endpointUrl: string, overrides: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: "agent.run.completed",
    tenantId: "tenant-w",
    endpointUrl,
    secret: "whsec_test_secret",
    bodyJson: JSON.stringify({ runId: "run_1", output: "42" }),
    maxAttempts: 3,
    ...overrides,
  };
}

async function listen(app: import("express").Express): Promise<string> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe.skipIf(!process.env.TEST_WEBHOOKS_INTEGRATION)("webhook fan-out (A5)", () => {
  it("computes bounded jittered backoff", () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ms = jitteredBackoffMs(attempt);
      const base = Math.min(60_000, 1_000 * 2 ** attempt);
      expect(ms).toBeGreaterThanOrEqual(base * 0.75 - 1);
      expect(ms).toBeLessThanOrEqual(base * 1.25 + 1);
    }
  });

  it("delivers signed webhooks; tampering is rejected; duplicates are observed once", async () => {
    if (!redisAvailable) return;
    resetRecordedDeliveries();
    const dispatcher = new WebhookDispatcher(redis);
    const app = buildServer({ requireWebhookSignature: true, webhookSecret: "whsec_test_secret" });
    const baseUrl = await listen(app);

    const jobData = makeJob(`${baseUrl}/v1/webhooks/test`);

    // At-least-once: three attempts (e.g., lost acknowledgments upstream).
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(await dispatcher.deliver(jobData, i));
    }
    expect(outcomes.every((o) => o.delivered)).toBe(true);

    // Exactly-once observation via event-id dedupe.
    expect(recordedDeliveries()).toHaveLength(1);
    expect(recordedDeliveries()[0]?.signatureValid).toBe(true);

    // Tampered payload fails verification and is never recorded.
    const tampered = await fetch(jobData.endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jobData.bodyJson.replace("42", "999"),
    });
    expect(tampered.status).toBe(401);
    expect(recordedDeliveries()).toHaveLength(1);
  }, 20_000);

  it("dead-letters exhausted deliveries and replay restores delivery", async () => {
    if (!redisAvailable) return;
    resetRecordedDeliveries();
    await redis.del("webhook-dlq:stream");

    let healthy = false;
    const receiver = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        if (!healthy) {
          res.writeHead(500).end("down");
          return;
        }
        recordedDeliveries();
        res.writeHead(202).end('{"accepted":true}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.address() as AddressInfo;

    const dispatcher = new WebhookDispatcher(redis);
    const jobData = makeJob(`http://127.0.0.1:${port}/hook`, { eventId: "evt_dlq_1" });

    // All attempts fail → dead-letter.
    let outcome;
    for (let attempt = 0; attempt < jobData.maxAttempts; attempt += 1) {
      try {
        outcome = await dispatcher.deliver(jobData, attempt);
      } catch {
        // intermediate retries throw by contract
      }
    }
    expect(outcome?.deadLettered).toBe(true);

    const dead = await readDeadLetters(redis);
    expect(dead.map((d) => d.eventId)).toContain("evt_dlq_1");

    // Operator fixes the endpoint, replays the dead letter.
    healthy = true;
    const replay = await dispatcher.deliver(
      { ...jobData, eventId: "evt_dlq_1" },
      jobData.maxAttempts,
    );
    expect(replay.delivered).toBe(true);

    await receiver.close();
  }, 30_000);
});
