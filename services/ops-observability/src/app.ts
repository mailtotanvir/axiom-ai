import Fastify, { FastifyError, FastifyInstance } from "fastify";

import { AxiomError, CORE_VERSION, errors, initTelemetry } from "@axiom-ai/core";

import { OpsConfig } from "./config.js";

export function buildApp(config: OpsConfig): FastifyInstance {
  const telemetry = initTelemetry({
    serviceName: "axiom-ops-observability",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  app.decorate("telemetry", telemetry);

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

  app.get("/readyz", async () => ({
    // Phase 4 (O1/O2): verify ClickHouse + Postgres reachability here.
    status: "ok",
    service: "axiom-ops-observability",
    version: CORE_VERSION,
  }));

  return app;
}
