/**
 * Ops & observability service (Phase 4). Wires the trace query API,
 * retention policies, and health checks over ClickHouse + Postgres.
 * Stores are injectable for tests.
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { AxiomError, CORE_VERSION, errors, initTelemetry } from "@axiom-ai/core";
import { type Pool } from "pg";

import { type OpsConfig } from "./config.js";
import { ClickHouseHttp, type ClickHouseClient } from "./clickhouse.js";
import { PostgresRetentionStore, type RetentionStore } from "./retention.js";
import { ClickHouseTraceStore, type TraceStore } from "./traces/store.js";
import { registerTraceRoutes } from "./traces/routes.js";

export interface OpsStores {
  clickhouse?: ClickHouseClient;
  traceStore?: TraceStore;
  retention?: RetentionStore;
  postgresPool?: Pool;
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

  const postgresPool = stores.postgresPool ?? null;
  const retention =
    stores.retention ??
    (config.POSTGRES_DB_URI !== undefined
      ? new PostgresRetentionStore(config.POSTGRES_DB_URI)
      : undefined);

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
    // O1: verify ClickHouse (+ Postgres when configured) reachability.
    const checks: Record<string, boolean | "skipped"> = {};
    let ready = true;
    if (clickhouse === undefined) {
      checks.clickhouse = "skipped";
    } else {
      checks.clickhouse = await clickhouse.ping();
      ready = ready && checks.clickhouse !== false;
    }
    if (retention instanceof PostgresRetentionStore) {
      const pgReady = postgresPool !== null ? await pingPostgres(postgresPool) : true;
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

  if (clickhouse !== undefined && retention !== undefined) {
    const traceStore = stores.traceStore ?? new ClickHouseTraceStore(clickhouse);
    registerTraceRoutes(app, {
      store: traceStore,
      retention,
      internalSecret: config.AXIOM_INTER_SERVICE_SECRET,
    });
  }

  app.decorate("closeStores", async () => {
    await retention?.close();
  });

  return app;
}

async function pingPostgres(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
