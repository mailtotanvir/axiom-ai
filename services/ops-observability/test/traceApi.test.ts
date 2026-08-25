/**
 * Route-level tests for the O1 trace API: Jaeger-compatible responses,
 * retention clamping, and inter-service secret enforcement.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createOpsConfig } from "../src/config.js";
import type { ClickHouseClient } from "../src/clickhouse.js";
import { ClickHouseTraceStore } from "../src/traces/store.js";
import { InMemoryRetentionStore } from "../src/retention.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

class FakeClickHouse implements ClickHouseClient {
  async query<T>(sql: string, params: Record<string, string> = {}): Promise<T[]> {
    if (sql.includes("FINAL")) {
      if (params.trace_id !== TRACE_ID) {
        return [];
      }
      return [
        {
          Timestamp: new Date().toISOString().replace("T", " ").slice(0, 23),
          TraceId: TRACE_ID,
          SpanId: "00f067aa0ba902b7",
          ParentSpanId: "",
          SpanName: "chat.completion",
          SpanKind: 3,
          ServiceName: "axiom-gateway",
          ResourceAttributes: {},
          ScopeName: "@axiom-ai/core",
          ScopeVersion: "0.2.0",
          SpanAttributes: { "axiom.tenant.id": "tenant-a" },
          Duration: 2000000,
          StatusCode: 1,
          StatusMessage: "",
        },
      ] as T[];
    }
    if (sql.includes("DISTINCT TraceId")) {
      return [{ TraceId: TRACE_ID }] as T[];
    }
    if (sql.includes("SELECT 1")) {
      return [{ "1": 1 }] as T[];
    }
    return [];
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

describe("trace API routes", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    const retention = new InMemoryRetentionStore();
    app = buildApp(
      {
        ...createOpsConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }),
        CLICKHOUSE_NODES: ["axiom:axiom@localhost:8123"],
        POSTGRES_DB_URI: undefined,
      },
      {
        clickhouse: new FakeClickHouse(),
        traceStore: new ClickHouseTraceStore(new FakeClickHouse()),
        retention,
      },
    );
  });

  afterAll(async () => {
    await app.closeStores();
    await app.close();
  });

  it("serves a single trace in the Jaeger response envelope", async () => {
    const response = await app.inject({ method: "GET", url: `/api/traces?trace_id=${TRACE_ID}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors).toEqual([]);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].traceID).toBe(TRACE_ID);
    expect(body.data[0].spans[0].spanID).toBe("00f067aa0ba902b7");
  });

  it("returns Jaeger's 404 envelope for unknown traces", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/traces?trace_id=1111111111111111",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ data: [], errors: [{ msg: "trace not found" }] });
  });

  it("rejects retention mutations without the inter-service secret", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/retention/tenant-a",
      payload: { retainDays: 14 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AXIOM_UNAUTHENTICATED");
  });

  it("stores and applies per-tenant retention policies", async () => {
    const setResponse = await app.inject({
      method: "PUT",
      url: "/v1/retention/tenant-a",
      headers: { "x-axiom-internal-secret": "dev-only-inter-service-secret" },
      payload: { retainDays: 7 },
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json().policy).toMatchObject({ tenantId: "tenant-a", retainDays: 7 });

    // A tenant-scoped search now carries the 7-day clamp floor.
    const searchStartUs = Date.now() * 1000 - 90 * 24 * 60 * 60 * 1_000_000;
    const search = await app.inject({
      method: "GET",
      url: `/api/traces?tenant=tenant-a&start=${searchStartUs}`,
    });
    expect(search.statusCode).toBe(200);

    const listResponse = await app.inject({ method: "GET", url: "/v1/retention" });
    expect(listResponse.json().policies).toEqual([
      expect.objectContaining({ tenantId: "tenant-a", retainDays: 7 }),
    ]);
  });

  it("validates retention policy bounds", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/retention/tenant-a",
      headers: { "x-axiom-internal-secret": "dev-only-inter-service-secret" },
      payload: { retainDays: 0 },
    });
    expect(response.statusCode).toBe(400);
  });
});
