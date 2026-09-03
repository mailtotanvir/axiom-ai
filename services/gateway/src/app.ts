import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

import {
  AxiomError,
  CORE_VERSION,
  createHttpMetrics,
  errors,
  globalMetrics,
  initTelemetry,
  type TelemetryHandle,
} from "@tanvir1971/core";

import type { GatewayConfig } from "./config.js";
import { buildRuntime, seedDevKeyIfMemoryStore, type GatewayRuntime } from "./runtime.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerAdminRoutes } from "./routes/adminKeys.js";

declare module "fastify" {
  interface FastifyInstance {
    telemetry: TelemetryHandle;
    runtime: GatewayRuntime;
  }
}

export async function buildApp(
  config: GatewayConfig,
  runtimeOverride?: GatewayRuntime,
): Promise<FastifyInstance> {
  const telemetry = initTelemetry({
    serviceName: "axiom-gateway",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const runtime = runtimeOverride ?? (await buildRuntime(config));
  const httpMetrics = createHttpMetrics("gateway");

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
    // Proxy requests may carry long prompts; keep the body limit generous
    // but bounded (8 MB covers ~2M characters of context).
    bodyLimit: 8 * 1024 * 1024,
    requestTimeout: config.GATEWAY_UPSTREAM_TIMEOUT_MS + 10_000,
  });
  app.decorate("telemetry", telemetry);
  app.decorate("runtime", runtime);

  app.addHook("onRequest", (request, _reply, done) => {
    (request.raw as { __startTime?: bigint }).__startTime = process.hrtime.bigint();
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const start = (request.raw as { __startTime?: bigint }).__startTime;
    if (start) {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const elapsedSeconds = elapsedNs / 1e9;
      const route = request.routeOptions?.url || request.url.split("?")[0] || "unknown";
      httpMetrics.record(request.method, route, reply.statusCode, elapsedSeconds);
    }
    done();
  });

  app.get("/metrics", async (_request, reply) => {
    void reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return globalMetrics.getMetricsAsText();
  });

  app.setErrorHandler((error: FastifyError | unknown, request, reply: FastifyReply) => {
    if (error instanceof AxiomError) {
      if (error.code === "AXIOM_RATE_LIMITED") {
        void reply.header("retry-after", String(30));
      }
      void reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      (error as FastifyError).validation !== undefined
    ) {
      void reply.status(400).send(errors.validationFailed((error as FastifyError).validation).toJSON());
      return;
    }
    request.log.error({ err: error }, "unhandled gateway error");
    void reply.status(500).send(errors.internal().toJSON());
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send(errors.notFound("Route").toJSON());
  });

  app.addHook("onClose", async () => {
    await runtime.close();
    await telemetry.shutdown();
  });

  registerHealthRoutes(app);
  registerModelRoutes(app, runtime.registry);
  registerChatRoute(app, runtime);
  registerAdminRoutes(app, runtime.keyStore);

  return app;
}

export async function startGateway(config: GatewayConfig): Promise<FastifyInstance> {
  const app = await buildApp(config);
  await seedDevKeyIfMemoryStore(app.runtime);
  await app.listen({ port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });
  app.log.info(
    `axiom-gateway ${CORE_VERSION} listening on ${config.GATEWAY_HOST}:${config.GATEWAY_PORT}`,
  );
  return app;
}
