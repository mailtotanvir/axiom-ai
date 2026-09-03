import express, { type Express, type Request, type Response } from "express";

import {
  CORE_VERSION,
  createHttpMetrics,
  errors,
  globalMetrics,
  SIGNATURE_HEADER,
  verifySignature,
} from "@tanvir1971/core";

export const queueDepthGauge = globalMetrics.registerGauge(
  "agent_runtime_queue_depth",
  "Current depth of agent runtime execution queues",
);

export interface ServerOptions {
  /** When true, webhook endpoints reject unsigned/tampered deliveries. */
  requireWebhookSignature?: boolean;
  /** Shared secret used to validate inbound signed deliveries in dev/test. */
  webhookSecret?: string;
}

export interface RecordedDelivery {
  eventId: string;
  signatureValid: boolean;
  body: string;
  receivedAt: string;
}

const receivers: Record<string, RecordedDelivery> = {};

export function recordedDeliveries(): RecordedDelivery[] {
  return Object.values(receivers);
}

export function resetRecordedDeliveries(): void {
  for (const key of Object.keys(receivers)) {
    delete receivers[key];
  }
}

export function buildServer(options: ServerOptions = {}): Express {
  const app = express();
  const httpMetrics = createHttpMetrics("agent-runtime");

  app.use((req: Request, res: Response, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const elapsedSeconds = elapsedNs / 1e9;
      const route = req.path || "unknown";
      httpMetrics.record(req.method, route, res.statusCode, elapsedSeconds);
    });
    next();
  });

  // Preserve the exact request bytes so signature verification is possible.
  app.use(express.raw({ type: "*/*", limit: "5mb" }));

  app.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(globalMetrics.getMetricsAsText());
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "axiom-agent-runtime", version: CORE_VERSION });
  });

  app.get("/readyz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "axiom-agent-runtime", version: CORE_VERSION });
  });

  /**
   * Signed webhook receiver used by fan-out integration tests. Dedupes on
   * `axiom-event-id` so at-least-once delivery yields exactly-once
   * observation; tampered payloads are rejected before recording.
   */
  app.post("/v1/webhooks/test", (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const secret = options.webhookSecret ?? "";
    const header = req.header(SIGNATURE_HEADER) ?? "";
    const signatureValid =
      secret !== "" && rawBody.length > 0 && verifySignature(secret, rawBody, header);

    if ((options.requireWebhookSignature ?? false) && !signatureValid) {
      res.status(401).json(errors.webhookSignatureInvalid().toJSON());
      return;
    }

    const eventId = req.header("axiom-event-id") ?? "";
    if (eventId !== "" && receivers[eventId] !== undefined) {
      // Duplicate delivery: acknowledge but do not re-observe.
      res.status(200).json({ accepted: true, duplicate: true });
      return;
    }

    receivers[eventId] = {
      eventId,
      signatureValid,
      body: rawBody,
      receivedAt: new Date().toISOString(),
    };
    res.status(202).json({ accepted: true, duplicate: false });
  });

  app.get("/v1/webhooks/test/_received", (_req: Request, res: Response) => {
    res.status(200).json({ deliveries: recordedDeliveries() });
  });

  return app;
}

/** Call AFTER all service-specific routes are registered. */
export function registerNotFoundHandler(app: Express): void {
  app.use((_req: Request, res: Response) => {
    res.status(404).json(errors.notFound("Route").toJSON());
  });
}
