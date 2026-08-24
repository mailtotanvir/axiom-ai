/**
 * Metering sinks (G6). Records are queued and flushed in batches —
 * ClickHouse via HTTP JSONEachRow (spec row 2), console for dev. Flushes
 * are size- or time-triggered and drained on shutdown.
 */

export interface MeterRecord {
  timestamp: string;
  requestId: string;
  tenantId: string;
  projectId: string;
  model: string;
  provider: string;
  streamed: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource: "reported" | "estimated" | "mixed";
  reconciliationDelta: number;
  costUsd: number;
  latencyMs: number;
  upstreamStatus: number;
}

export interface MeterSink {
  readonly name: string;
  record(entry: MeterRecord): Promise<void>;
  flush(): Promise<void>;
}

class BufferedSink implements MeterSink {
  protected queue: MeterRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(
    readonly name: string,
    private readonly emit: (batch: MeterRecord[]) => Promise<void>,
    private readonly maxBatchSize = 100,
    private readonly flushIntervalMs = 1_000,
  ) {}

  async record(entry: MeterRecord): Promise<void> {
    this.queue.push(entry);
    if (this.queue.length >= this.maxBatchSize) {
      await this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) {
      return;
    }
    this.flushing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.emit(batch);
    } catch (error) {
      // Metering must never take down request handling; drop after retry.
      console.error(`[metering:${this.name}] batch dropped`, error instanceof Error ? error.message : error);
    } finally {
      this.flushing = false;
    }
  }
}

export class ConsoleMeterSink extends BufferedSink {
  constructor() {
    super("console", async (batch) => {
      for (const entry of batch) {
        console.log(
          `[meter] ${entry.tenantId}/${entry.projectId} ${entry.model}@${entry.provider} ` +
            `${entry.totalTokens}t $${entry.costUsd.toFixed(6)} ${entry.latencyMs}ms` +
            `${entry.streamed ? " (stream)" : ""}`,
        );
      }
    });
  }
}

export class ClickHouseMeterSink extends BufferedSink {
  constructor(
    private readonly nodes: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
    maxBatchSize = 500,
  ) {
    super("clickhouse", (batch) => this.post(batch), maxBatchSize, 500);
  }

  private async post(batch: MeterRecord[]): Promise<void> {
    const body = batch
      .map((entry) =>
        JSON.stringify({
          // ClickHouse DateTime64 wants "YYYY-MM-DD HH:MM:SS.mmm".
          timestamp: entry.timestamp.replace("T", " ").replace("Z", ""),
          request_id: entry.requestId,
          tenant_id: entry.tenantId,
          project_id: entry.projectId,
          model: entry.model,
          provider: entry.provider,
          streamed: entry.streamed ? 1 : 0,
          prompt_tokens: entry.promptTokens,
          completion_tokens: entry.completionTokens,
          total_tokens: entry.totalTokens,
          usage_source: entry.usageSource,
          reconciliation_delta: entry.reconciliationDelta,
          cost_usd: entry.costUsd,
          latency_ms: entry.latencyMs,
          upstream_status: entry.upstreamStatus,
        }),
      )
      .join("\n");

    const query = "INSERT INTO axiom.metering_usage_events FORMAT JSONEachRow";
    let lastError: unknown;
    for (const node of this.nodes) {
      try {
        // Node format allows credentials: user:password@host:8123
        const url = new URL(`http://${node}`);
        const headers: Record<string, string> = { "content-type": "text/plain" };
        if (url.username !== "" || url.password !== "") {
          headers.authorization = `Basic ${Buffer.from(
            `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          ).toString("base64")}`;
          // undici refuses fetch() on URLs carrying credentials.
          url.username = "";
          url.password = "";
        }
        // ClickHouse requires %20 (not '+') for spaces in query params.
        url.search = `?query=${encodeURIComponent(query)}`;
        const response = await this.fetchImpl(url.toString(), {
          method: "POST",
          body,
          headers,
        });
        if (!response.ok) {
          throw new Error(`clickhouse ${url.host} responded ${response.status}`);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("no clickhouse nodes configured");
  }
}
