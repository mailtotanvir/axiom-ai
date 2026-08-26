/**
 * Ops & observability service (Phase 4). Wires the trace query API,
 * retention policies, and health checks over ClickHouse + Postgres.
 * Stores are injectable for tests.
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { AxiomError, CORE_VERSION, errors, initTelemetry } from "@axiom-ai/core";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type OpsConfig } from "./config.js";
import { ClickHouseHttp, type ClickHouseClient } from "./clickhouse.js";
import { InMemoryRetentionStore, PostgresRetentionStore, type RetentionStore } from "./retention.js";
import { ClickHouseTraceStore, type TraceStore } from "./traces/store.js";
import { registerTraceRoutes } from "./traces/routes.js";
import { registerPromptRoutes } from "./prompts/routes.js";
import { PrismaPromptRegistry } from "./prompts/store.js";
import { InMemoryPromptRegistry } from "./prompts/memoryStore.js";
import type { PromptRegistryStore } from "./prompts/types.js";
import { registerEvalRoutes } from "./evals/routes.js";
import { ClickHouseEvalResultsSink, EvalRunner, HttpGatewayChatClient } from "./evals/runner.js";
import type { EvalRunner as EvalRunnerType } from "./evals/runner.js";
import { PrismaEvalStore } from "./evals/store.js";
import type { EvalStore } from "./evals/store.js";
import { InMemoryEvalStore } from "./evals/stores.js";
import { registerExperimentRoutes } from "./experiments/routes.js";
import { PrismaExperimentStore } from "./experiments/store.js";
import type { ExperimentStore } from "./experiments/store.js";
import { InMemoryExperimentStore } from "./experiments/stores.js";

export interface OpsStores {
  clickhouse?: ClickHouseClient;
  traceStore?: TraceStore;
  retention?: RetentionStore;
  registry?: PromptRegistryStore;
  evalStore?: EvalStore;
  evalRunner?: EvalRunnerType;
  experimentStore?: ExperimentStore;
}

/** Applies the prompt-registry DDL idempotently (see prisma/ddl.sql). */
export async function migrateRegistry(dataSourceUrl: string): Promise<void> {
  const ddlPath = fileURLToPath(new URL("../prisma/ddl.sql", import.meta.url));
  const ddl = readFileSync(ddlPath, "utf8");
  const client = new PrismaClient({ datasources: { db: { url: dataSourceUrl } } });
  try {
    for (const statement of ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
      await client.$executeRawUnsafe(statement);
    }
  } finally {
    await client.$disconnect();
  }
}

export function buildApp(config: OpsConfig, stores: OpsStores = {}): FastifyInstance {
  const telemetry = initTelemetry({
    serviceName: "axiom-ops-observability",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  app.decorate("telemetry", telemetry);

  const clickhouse =
    stores.clickhouse ??
    (config.CLICKHOUSE_NODES !== undefined
      ? new ClickHouseHttp(config.CLICKHOUSE_NODES)
      : undefined);

  const retention =
    stores.retention ??
    (config.POSTGRES_DB_URI !== undefined
      ? new PostgresRetentionStore(config.POSTGRES_DB_URI)
      : undefined);

  const registry =
    stores.registry ??
    (config.POSTGRES_DB_URI !== undefined
      ? new PrismaPromptRegistry(config.POSTGRES_DB_URI)
      : new InMemoryPromptRegistry());

  const evalStore =
    stores.evalStore ??
    (config.POSTGRES_DB_URI !== undefined
      ? new PrismaEvalStore(config.POSTGRES_DB_URI)
      : new InMemoryEvalStore());

  const experimentStore =
    stores.experimentStore ??
    (config.POSTGRES_DB_URI !== undefined
      ? new PrismaExperimentStore(config.POSTGRES_DB_URI)
      : new InMemoryExperimentStore());

  const gatewayChat = new HttpGatewayChatClient(
    config.GATEWAY_INTERNAL_URL,
    // Evals authenticate as an internal caller of the gateway.
    process.env.AGENT_RUNTIME_LLM_API_KEY ?? "",
  );
  const evalRunner =
    stores.evalRunner ??
    new EvalRunner({
      evalStore,
      registry,
      resultsSink:
        clickhouse !== undefined
          ? new ClickHouseEvalResultsSink(clickhouse)
          : undefined,
      gateway: gatewayChat,
    });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AxiomError) {
      void reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    if (error.validation !== undefined) {
      void reply.status(400).send(errors.validationFailed(error.validation).toJSON());
      return;
    }
    request.log.error({ err: error }, "unhandled ops error");
    void reply.status(500).send(errors.internal().toJSON());
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send(errors.notFound("Route").toJSON());
  });

  app.get("/healthz", async () => ({
    status: "ok",
    service: "axiom-ops-observability",
    version: CORE_VERSION,
  }));

  app.get("/readyz", async (_request, reply) => {
    // O1/O2: verify ClickHouse + Postgres reachability where configured.
    const checks: Record<string, boolean | "skipped"> = {};
    let ready = true;
    if (clickhouse === undefined) {
      checks.clickhouse = "skipped";
    } else {
      checks.clickhouse = await clickhouse.ping();
      ready = ready && checks.clickhouse !== false;
    }
    if (config.POSTGRES_DB_URI === undefined) {
      checks.postgres = "skipped";
    } else {
      const pgReady = await pingPostgres(config.POSTGRES_DB_URI);
      checks.postgres = pgReady;
      ready = ready && pgReady;
    }
    if (!ready) {
      return reply.status(503).send({
        status: "degraded",
        service: "axiom-ops-observability",
        version: CORE_VERSION,
        checks,
      });
    }
    return {
      status: "ok",
      service: "axiom-ops-observability",
      version: CORE_VERSION,
      checks,
    };
  });

  registerTraceRoutes(app, {
    store:
      stores.traceStore ??
      new ClickHouseTraceStore(
        clickhouse ?? new ClickHouseHttp(["invalid:8123"]),
      ),
    retention: retention ?? new InMemoryRetentionStore(),
    internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
  });

  registerPromptRoutes(app, {
    registry,
    internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
  });

  registerEvalRoutes(app, {
    store: evalStore,
    runner: evalRunner,
    registry,
    internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
  });

  registerExperimentRoutes(app, {
    store: experimentStore,
    registry,
    internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
  });

  app.decorate("closeStores", async () => {
    await retention?.close();
  });

  return app;
}

async function pingPostgres(connectionString: string): Promise<boolean> {
  try {
    const client = new PrismaClient({ datasources: { db: { url: connectionString } } });
    try {
      await client.$queryRaw`SELECT 1`;
      return true;
    } finally {
      await client.$disconnect();
    }
  } catch {
    return false;
  }
}
