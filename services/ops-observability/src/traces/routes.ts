/**
 * Jaeger-compatible trace query API plus retention administration (O1).
 * Read endpoints mirror the Jaeger HTTP API JSON contract; mutations
 * require the inter-service secret header.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "@tanvir1971/core";

import type { TraceSearch, TraceStore } from "./store.js";
import type { RetentionStore } from "../retention.js";

export interface TraceRouteDeps {
  store: TraceStore;
  retention: RetentionStore;
  internalSecret: string;
}

function requireInternalSecret(
  request: { headers: Record<string, unknown> },
  secret: string,
): void {
  if (request.headers["x-axiom-internal-secret"] !== secret) {
    throw errors.unauthenticated("Missing or invalid inter-service secret.");
  }
}

export function registerTraceRoutes(app: FastifyInstance, deps: TraceRouteDeps): void {
  // ------------------------ Jaeger-compatible API ------------------------
  app.get("/api/services", async () => ({
    data: await deps.store.services(),
  }));

  app.get<{ Querystring: Record<string, string> }>(
    "/api/operations",
    async (request, reply) => {
      const service = request.query.service;
      if (service === undefined || service === "") {
        return reply
          .status(400)
          .send(errors.validationFailed([{ path: "service", message: "required" }]));
      }
      const operations = await deps.store.operations(service);
      return { data: operations.map((op) => op.name), operations };
    },
  );

  app.get<{ Querystring: Record<string, string> }>("/api/traces", async (request, reply) => {
    const query = request.query;
    if (query.trace_id !== undefined && query.trace_id !== "") {
      const trace = await deps.store.getTrace(query.trace_id);
      if (trace === null) {
        return reply.status(404).send({ data: [], errors: [{ msg: "trace not found" }] });
      }
      return { data: [trace], errors: [] };
    }

    const search: TraceSearch = {};
    const nowUs = Date.now() * 1000;

    // Per-tenant retention clamp: never look back past the policy window.
    let clampStartUs: number | null = null;
    if (query.tenant !== undefined && query.tenant !== "") {
      search.tenantId = query.tenant;
      const policyDays = await deps.retention.get(query.tenant);
      if (policyDays !== null) {
        clampStartUs = nowUs - policyDays * 24 * 60 * 60 * 1_000_000;
      }
    }

    if (query.service !== undefined && query.service !== "") {
      search.service = query.service;
    }
    const parseMicros = (raw: string | undefined): number | undefined => {
      if (raw === undefined || raw === "") {
        return undefined;
      }
      const value = Number(raw);
      return Number.isFinite(value) ? Math.round(value) : undefined;
    };
    const startUs = parseMicros(query.start);
    search.startUs =
      startUs === undefined
        ? clampStartUs ?? undefined
        : clampStartUs === null
          ? startUs
          : Math.max(startUs, clampStartUs);
    const endUs = parseMicros(query.end);
    if (endUs !== undefined) {
      search.endUs = endUs;
    }
    const limitRaw = Number(query.limit ?? "20");
    if (Number.isFinite(limitRaw) && limitRaw > 0) {
      search.limit = Math.floor(limitRaw);
    }

    try {
      const traces = await deps.store.search(search);
      return { data: traces, errors: [] };
    } catch (error) {
      request.log.error({ err: error }, "trace search failed");
      return reply.status(502).send({
        data: [],
        errors: [{ msg: "trace store unavailable" }],
      });
    }
  });

  // ------------------------- Retention policies --------------------------
  app.get("/v1/retention", async () => ({ policies: await deps.retention.list() }));

  app.put<{ Params: { tenantId: string }; Body: { retainDays?: number } }>(
    "/v1/retention/:tenantId",
    async (request, reply) => {
      requireInternalSecret(request, deps.internalSecret);
      const retainDays = request.body?.retainDays;
      if (
        typeof retainDays !== "number" ||
        !Number.isInteger(retainDays) ||
        retainDays < 1 ||
        retainDays > 3650
      ) {
        return reply.status(400).send(
          errors.validationFailed([
            { path: "retainDays", message: "must be an integer between 1 and 3650" },
          ]),
        );
      }
      const policy = await deps.retention.set(request.params.tenantId, retainDays);
      return { policy };
    },
  );
}
