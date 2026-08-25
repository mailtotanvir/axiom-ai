/**
 * Trace store (O1). Reads spans written by the OTel collector's ClickHouse
 * exporter (`axiom.otel_traces`, OTel schema) and shapes them into the
 * Jaeger HTTP-API JSON contract, so existing Jaeger tooling works against
 * the ops plane.
 */

import type { ClickHouseClient } from "../clickhouse.js";
import { axiomAttr } from "@axiom-ai/core";

/** Rows as materialized by the collector ClickHouse exporter. */
interface OtelTraceRow {
  Timestamp: string;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  SpanKind: number;
  ServiceName: string;
  ResourceAttributes: Record<string, string>;
  ScopeName: string;
  ScopeVersion: string;
  SpanAttributes: Record<string, string>;
  Duration: string | number;
  StatusCode: number;
  StatusMessage: string;
}

export interface JaegerTag {
  key: string;
  type: "string" | "int64" | "float64" | "bool";
  value: string | number | boolean;
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references: Array<{ refType: "CHILD_OF" | "FOLLOWS_FROM"; traceID: string; spanID: string }>;
  startTime: number;
  duration: number;
  tags: JaegerTag[];
  processID: string;
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string; tags: JaegerTag[] }>;
  warnings: string[];
}

export interface TraceSearch {
  traceId?: string;
  service?: string;
  tenantId?: string;
  /** Inclusive epoch-microseconds. */
  startUs?: number;
  /** Exclusive epoch-microseconds. */
  endUs?: number;
  limit?: number;
}

export interface TraceQueryResult {
  traces: JaegerTrace[];
  errors: Array<{ msg: string }>;
}

const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];

function tagOf(key: string, value: string): JaegerTag {
  const asNumber = Number(value);
  if (value !== "" && !Number.isNaN(asNumber)) {
    return { key, type: Number.isInteger(asNumber) ? "int64" : "float64", value: asNumber };
  }
  if (value === "true" || value === "false") {
    return { key, type: "bool", value: value === "true" };
  }
  return { key, type: "string", value };
}

function micros(timestamp: string): number {
  return Math.round(new Date(timestamp.replace(" ", "T").replace(/(\.\d{3})\d*Z?$/, "$1Z")).getTime() * 1000) ;
}

function toJaegerSpan(row: OtelTraceRow): JaegerSpan {
  const tags: JaegerTag[] = Object.entries(row.SpanAttributes ?? {}).map(([key, value]) =>
    tagOf(key, value),
  );
  if (row.StatusCode !== undefined && row.StatusCode !== 0) {
    tags.push({ key: "otel.status_code", type: "string", value: row.StatusCode === 2 ? "ERROR" : "OK" });
  }
  if (row.StatusMessage !== undefined && row.StatusMessage !== "") {
    tags.push({ key: "status.message", type: "string", value: row.StatusMessage });
  }
  const references =
    row.ParentSpanId !== "" && row.ParentSpanId !== "0000000000000000"
      ? [{ refType: "CHILD_OF" as const, traceID: row.TraceId, spanID: row.ParentSpanId }]
      : [];
  return {
    traceID: row.TraceId,
    spanID: row.SpanId,
    operationName: row.SpanName,
    references,
    startTime: micros(row.Timestamp),
    duration: Math.round(Number(row.Duration) / 1000),
    tags,
    processID: `p-${row.ServiceName}`,
  };
}

function toJaegerTrace(rows: OtelTraceRow[]): JaegerTrace | null {
  if (rows.length === 0) {
    return null;
  }
  const processes: JaegerTrace["processes"] = {};
  for (const service of new Set(rows.map((row) => row.ServiceName))) {
    const resourceRows = rows.filter((row) => row.ServiceName === service);
    processes[`p-${service}`] = {
      serviceName: service,
      tags: Object.entries(resourceRows[0]!.ResourceAttributes ?? {}).map(([key, value]) =>
        tagOf(key, value),
      ),
    };
  }
  return {
    traceID: rows[0]!.TraceId,
    spans: rows.map(toJaegerSpan),
    processes,
    warnings: [],
  };
}

function groupByTraceId(rows: OtelTraceRow[]): JaegerTrace[] {
  const grouped = new Map<string, OtelTraceRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.TraceId);
    if (bucket === undefined) {
      grouped.set(row.TraceId, [row]);
    } else {
      bucket.push(row);
    }
  }
  const traces: JaegerTrace[] = [];
  for (const rows of grouped.values()) {
    const trace = toJaegerTrace(rows);
    if (trace !== null) {
      traces.push(trace);
    }
  }
  return traces;
}

const SELECT_COLUMNS =
  "Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, " +
  "ResourceAttributes, ScopeName, ScopeVersion, SpanAttributes, Duration, StatusCode, StatusMessage";

export interface TraceStore {
  getTrace(traceId: string): Promise<JaegerTrace | null>;
  search(search: TraceSearch): Promise<JaegerTrace[]>;
  services(): Promise<string[]>;
  operations(service: string): Promise<Array<{ name: string; spanKind: string }>>;
}

export class ClickHouseTraceStore implements TraceStore {
  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly table = "axiom.otel_traces",
  ) {}

  async getTrace(traceId: string): Promise<JaegerTrace | null> {
    if (!/^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(traceId)) {
      return null;
    }
    const sql =
      `SELECT ${SELECT_COLUMNS} FROM ${this.table} FINAL WHERE TraceId = {trace_id:String} ` +
      "ORDER BY Timestamp ASC FORMAT JSONEachRow";
    const rows = await this.clickhouse.query<OtelTraceRow>(sql, { trace_id: traceId });
    return toJaegerTrace(rows);
  }

  async search(search: TraceSearch): Promise<JaegerTrace[]> {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (search.service !== undefined) {
      conditions.push("ServiceName = {service:String}");
      params.service = search.service;
    }
    if (search.tenantId !== undefined) {
      conditions.push(`SpanAttributes['${axiomAttr.tenantId}'] = {tenant:String}`);
      params.tenant = search.tenantId;
    }
    if (search.startUs !== undefined) {
      conditions.push("Timestamp >= fromUnixTimestamp64Micro({start:Int64})");
      params.start = String(search.startUs);
    }
    if (search.endUs !== undefined) {
      conditions.push("Timestamp < fromUnixTimestamp64Micro({end:Int64})");
      params.end = String(search.endUs);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(search.limit ?? 20, 1), 100);
    // Select matching trace ids first, then fetch their spans in one pass.
    const idSql =
      `SELECT DISTINCT TraceId FROM ${this.table} ${where} ORDER BY Timestamp DESC LIMIT ${limit} FORMAT JSONEachRow`;
    const idRows = await this.clickhouse.query<{ TraceId: string }>(idSql, params);
    if (idRows.length === 0) {
      return [];
    }
    const ids = idRows.map((row) => row.TraceId);
    const list = ids.map((id) => `'${id.replaceAll("'", "")}'`).join(",");
    const spanSql =
      `SELECT ${SELECT_COLUMNS} FROM ${this.table} WHERE TraceId IN (${list}) ` +
      "ORDER BY Timestamp ASC FORMAT JSONEachRow";
    const rows = await this.clickhouse.query<OtelTraceRow>(spanSql);
    return groupByTraceId(rows);
  }

  async services(): Promise<string[]> {
    const rows = await this.clickhouse.query<{ ServiceName: string }>(
      `SELECT DISTINCT ServiceName FROM ${this.table} ORDER BY ServiceName ASC FORMAT JSONEachRow`,
    );
    return rows.map((row) => row.ServiceName);
  }

  async operations(service: string): Promise<Array<{ name: string; spanKind: string }>> {
    const rows = await this.clickhouse.query<{ SpanName: string; SpanKind: number }>(
      "SELECT DISTINCT SpanName, SpanKind FROM axiom.otel_traces " +
        "WHERE ServiceName = {service:String} ORDER BY SpanName ASC FORMAT JSONEachRow",
      { service },
    );
    return rows.map((row) => ({
      name: row.SpanName,
      spanKind: SPAN_KINDS[row.SpanKind] ?? "unspecified",
    }));
  }
}
