import Fastify, { FastifyError, FastifyInstance, FastifyReply } from "fastify";

import { AxiomError, CORE_VERSION, errors, initTelemetry } from "@axiom-ai/core";

import { GatewayConfig } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";

export interface AppDeps {
  /** Injection point for Phase 1 services (rate limiter, router, meter). */
}

export function buildApp(config: GatewayConfig): FastifyInstance {
  const telemetry = initTelemetry({
    serviceName: "axiom-gateway",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers['x-api-key']",
          "req.headers.cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    disableRequestLogging: false,
  });

  app.decorate("telemetry", telemetry);
  app.decorateRequest("tenant", null);

  app.setErrorHandler((error: FastifyError, request, reply: FastifyReply) => {
    if (error instanceof AxiomError) {
      if (error.code === "AXIOM_RATE_LIMITED") {
        void reply.header("retry-after", 30);
      }
      void reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    if (error.validation !== undefined) {
      void reply
        .status(400)
        .send(errors.validationFailed(error.validation).toJSON());
      return;
    }
    request.log.error({ err: error }, "unhandled gateway error");
    void reply.status(500).send(errors.internal().toJSON());
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send(errors.notFound("Route").toJSON());
  });

  registerHealthRoutes(app);
  registerModelRoutes(app);

  return app;
}
