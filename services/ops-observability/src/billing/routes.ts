import { type FastifyInstance } from "fastify";

import { errors } from "@tanvir1971/core";

import { type BillingSync, billingEnabled, type BillingConfig } from "./billing.js";

export interface BillingRouteOptions {
  config: BillingConfig;
  /** Test/fixture seam; in production this wraps the ClickHouse metering table. */
  billingSync?: BillingSync;
  /** Restricts invoice preview to the inter-service admin caller. */
  internalSecret: string;
}

export function registerBillingRoutes(app: FastifyInstance, options: BillingRouteOptions): void {
  if (!billingEnabled(options.config)) {
    // Flag off (default): routes are absent entirely, not 404-by-policy.
    return;
  }
  const sync = options.billingSync;
  if (!sync) return;

  const requireAdmin = async (request: { headers: Record<string, string | string[] | undefined> }): Promise<boolean> => {
    const header = request.headers["x-axiom-internal-secret"];
    const value = Array.isArray(header) ? header[0] : header;
    return value === options.internalSecret;
  };

  app.post("/v1/billing/sync-usage", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      throw errors.forbiddenTenant("billing sync requires admin secret");
    }
    const body = (request.body ?? {}) as { periodMs?: number };
    const periodMs = typeof body.periodMs === "number" && body.periodMs > 0 ? body.periodMs : Date.now();
    const results = await sync.syncUsage(periodMs);
    return reply.send({ synced: results.length, results });
  });

  app.get("/v1/billing/invoice-preview", async (request, reply) => {
    if (!(await requireAdmin(request))) {
      throw errors.forbiddenTenant("invoice preview requires admin secret");
    }
    const query = request.query as { subscription?: string };
    if (!query.subscription) {
      return reply.status(400).send({ error: "subscription query parameter is required" });
    }
    const preview = await sync.invoicePreview(query.subscription);
    return reply.send(preview);
  });
}
