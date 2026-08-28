/**
 * Prometheus / OpenMetrics registry and instrumentation primitives.
 * Shared across TypeScript services to export standard /metrics endpoints
 * consumed by Prometheus and Grafana (O5, Milestone 5.1).
 */

export interface MetricLabels {
  [key: string]: string | number;
}

function formatLabels(labels?: MetricLabels): string {
  if (!labels) return "";
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  const formatted = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${formatted}}`;
}

function labelsKey(labels?: MetricLabels): string {
  if (!labels) return "";
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export class Counter {
  private values = new Map<string, { value: number; labels?: MetricLabels }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  inc(labels?: MetricLabels, value = 1): void {
    if (value < 0) throw new Error("Counter value must be non-negative");
    const key = labelsKey(labels);
    const current = this.values.get(key)?.value ?? 0;
    this.values.set(key, { value: current + value, labels });
  }

  get(labels?: MetricLabels): number {
    return this.values.get(labelsKey(labels))?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const { value, labels } of this.values.values()) {
        lines.push(`${this.name}${formatLabels(labels)} ${value}`);
      }
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private values = new Map<string, { value: number; labels?: MetricLabels }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
  ) {}

  set(value: number, labels?: MetricLabels): void {
    const key = labelsKey(labels);
    this.values.set(key, { value, labels });
  }

  inc(labels?: MetricLabels, value = 1): void {
    const key = labelsKey(labels);
    const current = this.values.get(key)?.value ?? 0;
    this.values.set(key, { value: current + value, labels });
  }

  dec(labels?: MetricLabels, value = 1): void {
    const key = labelsKey(labels);
    const current = this.values.get(key)?.value ?? 0;
    this.values.set(key, { value: current - value, labels });
  }

  get(labels?: MetricLabels): number {
    return this.values.get(labelsKey(labels))?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const { value, labels } of this.values.values()) {
        lines.push(`${this.name}${formatLabels(labels)} ${value}`);
      }
    }
    return lines.join("\n");
  }
}

export const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10,
];

interface HistogramBucketState {
  count: number;
  sum: number;
  buckets: number[];
  labels?: MetricLabels;
}

export class Histogram {
  private values = new Map<string, HistogramBucketState>();
  public readonly buckets: readonly number[];

  constructor(
    public readonly name: string,
    public readonly help: string,
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels?: MetricLabels): void {
    const key = labelsKey(labels);
    let state = this.values.get(key);
    if (!state) {
      state = {
        count: 0,
        sum: 0,
        buckets: new Array(this.buckets.length).fill(0),
        labels,
      };
      this.values.set(key, state);
    }
    state.count += 1;
    state.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      const bound = this.buckets[i];
      if (bound !== undefined && value <= bound) {
        state.buckets[i] = (state.buckets[i] ?? 0) + 1;
      }
    }
  }

  reset(): void {
    this.values.clear();
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    if (this.values.size === 0) {
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket{le="${b}"} 0`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    } else {
      for (const state of this.values.values()) {
        const baseLabels = state.labels ?? {};
        for (let i = 0; i < this.buckets.length; i++) {
          const bound = this.buckets[i];
          const count = state.buckets[i] ?? 0;
          if (bound !== undefined) {
            lines.push(
              `${this.name}_bucket${formatLabels({ ...baseLabels, le: bound })} ${count}`,
            );
          }
        }
        lines.push(
          `${this.name}_bucket${formatLabels({ ...baseLabels, le: "+Inf" })} ${state.count}`,
        );
        lines.push(
          `${this.name}_sum${formatLabels(baseLabels)} ${state.sum}`,
        );
        lines.push(
          `${this.name}_count${formatLabels(baseLabels)} ${state.count}`,
        );
      }
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  registerCounter(name: string, help: string): Counter {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = new Counter(name, help);
      this.counters.set(name, counter);
    }
    return counter;
  }

  registerGauge(name: string, help: string): Gauge {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = new Gauge(name, help);
      this.gauges.set(name, gauge);
    }
    return gauge;
  }

  registerHistogram(
    name: string,
    help: string,
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ): Histogram {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram(name, help, buckets);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }

  getMetricsAsText(): string {
    const parts: string[] = [];
    for (const c of this.counters.values()) {
      parts.push(c.toPrometheus());
    }
    for (const g of this.gauges.values()) {
      parts.push(g.toPrometheus());
    }
    for (const h of this.histograms.values()) {
      parts.push(h.toPrometheus());
    }
    return parts.join("\n\n") + "\n";
  }

  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const globalMetrics = new MetricsRegistry();

export interface HttpMetrics {
  durationHistogram: Histogram;
  requestsTotal: Counter;
  errorsTotal: Counter;
  record(method: string, route: string, statusCode: number, durationSeconds: number): void;
}

export function createHttpMetrics(
  serviceName: string,
  registry: MetricsRegistry = globalMetrics,
): HttpMetrics {
  const durationHistogram = registry.registerHistogram(
    "http_server_request_duration_seconds",
    "HTTP server request duration in seconds",
  );
  const requestsTotal = registry.registerCounter(
    "http_server_requests_total",
    "Total count of HTTP server requests",
  );
  const errorsTotal = registry.registerCounter(
    "http_server_requests_errors_total",
    "Total count of HTTP server 5xx errors",
  );

  return {
    durationHistogram,
    requestsTotal,
    errorsTotal,
    record(method: string, route: string, statusCode: number, durationSeconds: number): void {
      const labels = {
        job: serviceName,
        method: method.toUpperCase(),
        route: route || "unknown",
        status: String(statusCode),
      };
      durationHistogram.observe(durationSeconds, labels);
      requestsTotal.inc(labels);
      if (statusCode >= 500) {
        errorsTotal.inc({
          job: serviceName,
          method: method.toUpperCase(),
          route: route || "unknown",
        });
      }
    },
  };
}
