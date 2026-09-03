import "fastify";

import type { TelemetryHandle } from "@tanvir1971/core";

declare module "fastify" {
  interface FastifyInstance {
    telemetry: TelemetryHandle;
    closeStores: () => Promise<void>;
  }
}
