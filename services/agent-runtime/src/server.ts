import express, { Express, Request, Response } from "express";

import { CORE_VERSION, errors } from "@axiom-ai/core";

export interface ServerOptions {
  /** When true, webhook endpoints verify HMAC signatures (Phase 3 wires keys). */
  requireWebhookSignature?: boolean;
}

export function buildServer(_options: ServerOptions = {}): Express {
  const app = express();
  // Preserve the exact request bytes so signature verification is possible.
  app.use(express.raw({ type: "*/*", limit: "5mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "axiom-agent-runtime", version: CORE_VERSION });
  });

  app.get("/readyz", (_req: Request, res: Response) => {
    // Phase 0: readiness mirrors liveness; Phase 1 adds a Redis ping.
    res.status(200).json({ status: "ok", service: "axiom-agent-runtime", version: CORE_VERSION });
  });

  app.post("/v1/webhooks/test", (_req: Request, res: Response) => {
    // Receiver stub used by integration tests of the fan-out dispatcher (A5).
    res.status(202).json({ accepted: true });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json(errors.notFound("Route").toJSON());
  });

  return app;
}
