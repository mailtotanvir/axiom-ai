import type { FastifyInstance } from "fastify";

import { CORE_VERSION } from "@axiom-ai/core";

interface HealthResponse {
  status: "ok";
  service: "axiom-gateway";
  version: string;
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get<{ Reply: HealthResponse }>("/healthz", async () => ({
    status: "ok",
    service: "axiom-gateway",
    version: CORE_VERSION,
  }));

  // Phase 0 scaffold: readiness mirrors liveness. Phase 1 wires Redis and
  // upstream provider checks into this handler.
  app.get<{ Reply: HealthResponse }>("/readyz", async () => ({
    status: "ok",
    service: "axiom-gateway",
    version: CORE_VERSION,
  }));
}
