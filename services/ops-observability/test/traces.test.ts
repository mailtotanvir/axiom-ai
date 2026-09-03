/**
 * O1 trace store tests. A scripted ClickHouse double stands in for the
 * collector-written `axiom.otel_traces` table; assertions cover the
 * Jaeger-compatible mapping, search parameterization, and id validation.
 */

import { describe, expect, it } from "vitest";

import type { ClickHouseClient } from "../src/clickhouse.js";
import { ClickHouseTraceStore } from "../src/traces/store.js";
import { InMemoryRetentionStore } from "../src/retention.js";

const TRACE_ID_32 = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_ID_16 = "1234567890abcdef";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Timestamp: "2026-08-25 12:00:00.123456789",
    TraceId: TRACE_ID_32,
    SpanId: "00f067aa0ba902b7",
    ParentSpanId: "",
    SpanName: "chat.completion",
    SpanKind: 3,
    ServiceName: "axiom-gateway",
    ResourceAttributes: { "service.name": "axiom-gateway", deployment: "compose" },
    ScopeName: "@tanvir1971/core",
    ScopeVersion: "0.2.0",
    SpanAttributes: {
      "gen_ai.system": "groq",
      "gen_ai.usage.total_tokens": "17",
      "axiom.tenant.id": "tenant-a",
    },
    Duration: 1500000,
    StatusCode: 1,
    StatusMessage: "",
    ...overrides,
  };
}

class FakeClickHouse implements ClickHouseClient {
  readonly queries: Array<{ sql: string; params: Record<string, string> }> = [];
  private resultsByMatch: Array<{ match: RegExp; rows: Array<Record<string, unknown>> }> = [];

  script(match: RegExp, rows: Array<Record<string, unknown>>): void {
    this.resultsByMatch.push({ match, rows });
  }

  async query<T>(sql: string, queryParameters: Record<string, string> = {}): Promise<T[]> {
    this.queries.push({ sql, params: queryParameters });
    const hit = this.resultsByMatch.find((entry) => entry.match.test(sql));
    return (hit?.rows ?? []) as T[];
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

describe("ClickHouseTraceStore", () => {
  it("returns a Jaeger-shaped trace with spans and processes", async () => {
    const ch = new FakeClickHouse();
    ch.script(/FROM axiom\.otel_traces FINAL/, [row(), row({ SpanId: "aaaabbbbccccdddd", ParentSpanId: "00f067aa0ba902b7", SpanName: "http POST /v1/chat/completions" })]);
    const store = new ClickHouseTraceStore(ch);

    const trace = await store.getTrace(TRACE_ID_32);

    expect(trace).not.toBeNull();
    expect(trace!.traceID).toBe(TRACE_ID_32);
    expect(trace!.spans).toHaveLength(2);
    expect(trace!.spans[1]!.references[0]).toEqual({
      refType: "CHILD_OF",
      traceID: TRACE_ID_32,
      spanID: "00f067aa0ba902b7",
    });
    expect(trace!.processes["p-axiom-gateway"]!.serviceName).toBe("axiom-gateway");
    // Gen-AI attributes become Jaeger tags; numeric strings typed as int64.
    expect(trace!.spans[0]!.tags).toContainEqual({
      key: "gen_ai.usage.total_tokens",
      type: "int64",
      value: 17,
    });
    // Duration nanoseconds → Jaeger microseconds.
    expect(trace!.spans[0]!.duration).toBe(1500);
  });

  it("rejects malformed trace ids before querying", async () => {
    const store = new ClickHouseTraceStore(new FakeClickHouse());
    expect(await store.getTrace("'; DROP TABLE users")).toBeNull();
    expect(await store.getTrace("short")).toBeNull();
  });

  it("search filters by tenant attribute and clamps to retention window at the route layer", async () => {
    const ch = new FakeClickHouse();
    ch.script(/DISTINCT TraceId/, [{ TraceId: TRACE_ID_16 }]);
    ch.script(/TraceId IN/, [
      row({ TraceId: TRACE_ID_16 }),
      row({ TraceId: TRACE_ID_16, ServiceName: "axiom-agent-runtime", SpanName: "tool.exec" }),
    ]);
    const store = new ClickHouseTraceStore(ch);

    const traces = await store.search({
      tenantId: "tenant-a",
      startUs: Date.now() * 1000 - 60_000_000,
      limit: 10,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]!.spans.map((span) => span.operationName)).toEqual([
      "chat.completion",
      "tool.exec",
    ]);

    const idQuery = ch.queries.find((query) => query.sql.includes("DISTINCT TraceId"))!;
    expect(idQuery.sql).toContain("SpanAttributes['axiom.tenant.id'] = {tenant:String}");
    expect(idQuery.params.tenant).toBe("tenant-a");
    expect(idQuery.sql).toContain("fromUnixTimestamp64Micro");
  });

  it("lists services and operations", async () => {
    const ch = new FakeClickHouse();
    ch.script(/DISTINCT ServiceName/, [
      { ServiceName: "axiom-gateway" },
      { ServiceName: "axiom-rag-pipeline" },
    ]);
    ch.script(/DISTINCT SpanName, SpanKind/, [
      { SpanName: "retrieve.chunks", SpanKind: 1 },
      { SpanName: "ingest.document", SpanKind: 1 },
    ]);
    const store = new ClickHouseTraceStore(ch);

    expect(await store.services()).toEqual(["axiom-gateway", "axiom-rag-pipeline"]);
    // Ordering comes from the store's SQL `ORDER BY SpanName`; the fake
    // returns scripted order, so mirror it here.
    expect(await store.operations("axiom-rag-pipeline")).toEqual([
      { name: "retrieve.chunks", spanKind: "internal" },
      { name: "ingest.document", spanKind: "internal" },
    ]);
  });
});

describe("InMemoryRetentionStore", () => {
  it("round-trips policies deterministically", async () => {
    const store = new InMemoryRetentionStore();
    await store.set("tenant-b", 7);
    await store.set("tenant-a", 90);
    expect(await store.get("tenant-b")).toBe(7);
    expect((await store.list()).map((policy) => policy.tenantId)).toEqual(["tenant-a", "tenant-b"]);
  });
});
