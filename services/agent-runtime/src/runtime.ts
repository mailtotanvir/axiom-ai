import http from "node:http";

import { CORE_VERSION, initTelemetry } from "@axiom-ai/core";

import { type AgentRuntimeConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createQueues, type RuntimeQueues } from "./queues.js";

export interface RunningRuntime {
  server: http.Server;
  queues: RuntimeQueues;
  shutdown: () => Promise<void>;
}

export async function startRuntime(config: AgentRuntimeConfig): Promise<RunningRuntime> {
  const telemetry = initTelemetry({
    serviceName: "axiom-agent-runtime",
    serviceVersion: CORE_VERSION,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const queues = createQueues(config.REDIS_PRIMARY_URL ?? "redis://localhost:6379/0");
  const app = buildServer();

  const server = http.createServer(app);
  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.AGENT_RUNTIME_PORT, config.AGENT_RUNTIME_HOST, resolve);
  });
  await listen;

  console.log(
    `axiom-agent-runtime ${CORE_VERSION} listening on ${config.AGENT_RUNTIME_HOST}:${config.AGENT_RUNTIME_PORT}`,
  );

  return {
    server,
    queues,
    shutdown: async () => {
      await telemetry.shutdown();
      await queues.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
