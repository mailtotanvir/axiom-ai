import { describe, it, expect, beforeEach } from "vitest";
import {
  MetricsRegistry,
  createHttpMetrics,
} from "../src/metrics.js";

describe("Prometheus Metrics Registry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it("increments counters with and without labels", () => {
    const counter = registry.registerCounter("test_total", "Test counter");
    counter.inc();
    counter.inc(undefined, 2);
    counter.inc({ method: "GET", status: "200" });
    counter.inc({ method: "GET", status: "200" }, 3);

    expect(counter.get()).toBe(3);
    expect(counter.get({ method: "GET", status: "200" })).toBe(4);
    expect(counter.get({ method: "POST", status: "500" })).toBe(0);

    const output = counter.toPrometheus();
    expect(output).toContain("# HELP test_total Test counter");
    expect(output).toContain("# TYPE test_total counter");
    expect(output).toContain('test_total{method="GET",status="200"} 4');
  });

  it("sets, increments, and decrements gauges", () => {
    const gauge = registry.registerGauge("test_gauge", "Test gauge");
    gauge.set(10, { queue: "agent-exec" });
    gauge.inc({ queue: "agent-exec" }, 5);
    gauge.dec({ queue: "agent-exec" }, 3);

    expect(gauge.get({ queue: "agent-exec" })).toBe(12);

    const output = gauge.toPrometheus();
    expect(output).toContain("# HELP test_gauge Test gauge");
    expect(output).toContain("# TYPE test_gauge gauge");
    expect(output).toContain('test_gauge{queue="agent-exec"} 12');
  });

  it("observes values in histogram buckets", () => {
    const hist = registry.registerHistogram(
      "test_latency_seconds",
      "Test latency",
      [0.01, 0.05, 0.1, 1.0],
    );

    hist.observe(0.005, { job: "gateway" });
    hist.observe(0.03, { job: "gateway" });
    hist.observe(0.5, { job: "gateway" });

    const output = hist.toPrometheus();
    expect(output).toContain("# HELP test_latency_seconds Test latency");
    expect(output).toContain("# TYPE test_latency_seconds histogram");
    expect(output).toContain('test_latency_seconds_bucket{job="gateway",le="0.01"} 1');
    expect(output).toContain('test_latency_seconds_bucket{job="gateway",le="0.05"} 2');
    expect(output).toContain('test_latency_seconds_bucket{job="gateway",le="0.1"} 2');
    expect(output).toContain('test_latency_seconds_bucket{job="gateway",le="1"} 3');
    expect(output).toContain('test_latency_seconds_bucket{job="gateway",le="+Inf"} 3');
    expect(output).toContain('test_latency_seconds_sum{job="gateway"} 0.535');
    expect(output).toContain('test_latency_seconds_count{job="gateway"} 3');
  });

  it("records HTTP metrics correctly", () => {
    const httpMetrics = createHttpMetrics("gateway", registry);
    httpMetrics.record("GET", "/healthz", 200, 0.002);
    httpMetrics.record("POST", "/v1/chat/completions", 500, 0.15);

    const text = registry.getMetricsAsText();
    expect(text).toContain('http_server_requests_total{job="gateway",method="GET",route="/healthz",status="200"} 1');
    expect(text).toContain('http_server_requests_total{job="gateway",method="POST",route="/v1/chat/completions",status="500"} 1');
    expect(text).toContain('http_server_requests_errors_total{job="gateway",method="POST",route="/v1/chat/completions"} 1');
    expect(text).toContain('http_server_request_duration_seconds_count{job="gateway",method="GET",route="/healthz",status="200"} 1');
  });
});
