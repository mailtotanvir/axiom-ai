import http from "node:http";

import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Redis as RedisClient } from "ioredis";
import { z } from "zod";

import { CORE_VERSION, errors, initTelemetry } from "@tanvir1971/core";

import { AgentOrchestrator } from "./agents/orchestrator.js";
import { GatewayLlmClient, type LlmClient } from "./agents/llm.js";
import {
  InMemoryRunEventStore,
  PostgresRunEventStore,
  type RunEventStore,
} from "./agents/eventStore.js";
import { ToolRegistry } from "./sandbox/registry.js";
import { IsolatedVmExecutor } from "./sandbox/isolatedVmExecutor.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { createQueues, QUEUE_NAMES, type RuntimeQueues } from "./queues.js";
import { buildServer, registerNotFoundHandler } from "./server.js";
import type { AgentRuntimeConfig } from "./config.js";

export interface RunningRuntime {
  server: http.Server;
  queues: RuntimeQueues;
  orchestrator: AgentOrchestrator;
  shutdown: () => Promise<void>;
}

/** Default tool catalog registered at boot (extendable via registry API later). */
function defaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry(new IsolatedVmExecutor());
  registry.register({
    name: "calculator",
    description: "Evaluate an arithmetic expression. input: { expression: string }",
    timeoutMs: 2_000,
    memoryMb: 32,
    source: `
      function tool(input) {
        if (typeof input.expression !== "string") throw new Error("expression required");
        const sanitized = input.expression.replace(/[^0-9+\\-*/(). %]/g, "");
        const value = Function('"use strict"; return (' + sanitized + ')')();
        return { value };
      }
    `,
  });
  return registry;
}

const BOOTSTRAP_MODEL_WINDOWS = new Map<string, number>([
  ["gemini-3.6-flash", 1_000_000],
  ["openai/gpt-oss-120b", 131_072],
  ["mistral-large-latest", 131_072],
]);

const runSubmissionSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1).default("default"),
  idempotencyKey: z.string().min(1),
  input: z.object({
    messages: z
      .array(z.object({ role: z.enum(["system", "user"]), content: z.string() }))
      .min(1),
  }),
  definition: z.object({
    model: z.string().min(1),
    systemPrompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    maxSteps: z.number().int().min(1).max(64).default(8),
    maxTotalTokens: z.number().int().min(256).default(100_000),
    requiresApproval: z.boolean().optional(),
  }),
  approval: z.object({ grantedBy: z.string().min(1) }).optional(),
});

function priorityFor(tier: unknown): number {
  // BullMQ: lower value = processed sooner. Enterprise lanes first.
  if (tier === "enterprise") return 1;
  if (tier === "pro") return 5;
  return 9;
}

function connectionOf(config: AgentRuntimeConfig): { url: string } {
  return { url: config.REDIS_PRIMARY_URL ?? "redis://localhost:6379/0" };
}

export async function startRuntime(config: AgentRuntimeConfig): Promise<RunningRuntime> {
  const telemetry = initTelemetry({
    serviceName: "axiom-agent-runtime",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  // ------------------------------ Storage -------------------------------
  let eventStore: RunEventStore = new InMemoryRunEventStore();
  if (config.AGENT_RUNTIME_PG_URI !== undefined && config.AGENT_RUNTIME_PG_URI !== "") {
    try {
      const pgStore = new PostgresRunEventStore(config.AGENT_RUNTIME_PG_URI);
      await pgStore.migrate();
      eventStore = pgStore;
    } catch {
      eventStore = new InMemoryRunEventStore();
    }
  }

  // ------------------------------- Agents -------------------------------
  const llm: LlmClient = new GatewayLlmClient(
    config.GATEWAY_INTERNAL_URL,
    config.AGENT_RUNTIME_LLM_API_KEY,
    fetch,
    telemetry.tracer,
  );
  const orchestrator = new AgentOrchestrator({
    llm,
    eventStore,
    registry: defaultToolRegistry(),
    modelWindows: BOOTSTRAP_MODEL_WINDOWS,
  });

  const redisUrl = config.REDIS_PRIMARY_URL ?? "redis://localhost:6379/0";
  const queues = createQueues(redisUrl);
  const dlqRedis: RedisClient = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  dlqRedis.on("error", () => undefined);
  await dlqRedis.connect().catch(() => undefined);

  // --------------------------- Webhook fan-out ---------------------------
  const dispatcher = new WebhookDispatcher(dlqRedis);

  // ------------------------------ HTTP API ------------------------------
  const app = buildServer();

  app.post("/v1/agents/runs", async (req, res) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse((req.body as Buffer | undefined)?.toString("utf8") ?? "{}");
    } catch {
      res.status(400).json(errors.validationFailed("body must be JSON").toJSON());
      return;
    }
    const parsed = runSubmissionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      res.status(400).json(errors.validationFailed(parsed.error.flatten()).toJSON());
      return;
    }
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { tenantId, projectId, idempotencyKey, input, definition, approval } = parsed.data;
    try {
      // Idempotent dedupe happens in the event store; jobId stays colon-free
      // (a BullMQ custom-id constraint).
      await queues.agentExec.add(
        "agent-run",
        { runId, tenantId, projectId, idempotencyKey, input, definition, ...(approval ? { approval } : {}) },
        { jobId: runId, priority: priorityFor((parsedJson as { tier?: string }).tier) },
      );
    } catch (error) {
      console.error("[agent-runtime] enqueue failed", error instanceof Error ? error.message : error);
      res.status(500).json(errors.internal().toJSON());
      return;
    }
    res.status(202).json({ runId, state: "queued" });
  });

  app.get("/v1/agents/runs/:runId", async (req, res) => {
    const status = await orchestrator.status((req.params as { runId: string }).runId);
    if (status === undefined) {
      res.status(404).json(errors.notFound("Run").toJSON());
      return;
    }
    res.status(200).json(status);
  });

  app.get("/v1/agents/runs/:runId/events", async (req, res) => {
    const events = await orchestrator.events((req.params as { runId: string }).runId);
    if (events.length === 0) {
      res.status(404).json(errors.notFound("Run").toJSON());
      return;
    }
    res.status(200).json({ events });
  });

  registerNotFoundHandler(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.AGENT_RUNTIME_PORT, config.AGENT_RUNTIME_HOST, resolve);
  });

  console.log(
    `axiom-agent-runtime ${CORE_VERSION} listening on ${config.AGENT_RUNTIME_HOST}:${config.AGENT_RUNTIME_PORT}`,
  );

  // -------------------------------- Workers --------------------------------
  const agentWorker = new Worker(
    QUEUE_NAMES.agentExec,
    async (job) => {
      const data = job.data as { [key: string]: unknown; runId: string };
      const parsed = runSubmissionSchema.safeParse(data);
      if (!parsed.success) {
        throw errors.validationFailed("queued run payload invalid");
      }
      const { tenantId, projectId, idempotencyKey, input, definition, approval } = parsed.data;
      await orchestrator.execute({
        runId: data.runId,
        tenantId,
        projectId,
        idempotencyKey,
        input,
        definition,
        ...(approval !== undefined ? { approval } : {}),
      });
    },
    { connection: connectionOf(config), concurrency: 4 },
  );
  agentWorker.on("failed", (_job, err) => {
    console.error(`[agent-exec] job failed: ${err.message}`);
  });
  agentWorker.on("error", (err) => {
    console.error(`[agent-exec] worker error: ${err.message}`);
  });

  const webhookWorker = new Worker(
    QUEUE_NAMES.webhookDelivery,
    async (job) => {
      await dispatcher.deliver(job.data as never, job.attemptsMade);
    },
    { connection: connectionOf(config), concurrency: 8 },
  );

  return {
    server,
    queues,
    orchestrator,
    shutdown: async () => {
      await Promise.allSettled([agentWorker.close(), webhookWorker.close()]);
      await telemetry.shutdown();
      await queues.close();
      dlqRedis.disconnect();
      await eventStore.close?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
