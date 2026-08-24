import "fastify";

import type { TelemetryHandle } from "@axiom-ai/core";

declare module "fastify" {
  interface FastifyInstance {
    telemetry: TelemetryHandle;
  }
}
