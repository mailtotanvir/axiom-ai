/**
 * Minimal ClickHouse HTTP client (O1). Speaks the same user:pass@host:8123
 * node format as the gateway metering sink; queries return JSON rows.
 */

export interface ClickHouseClient {
  query<T>(sql: string, queryParameters?: Record<string, string>): Promise<T[]>;
  /** Bulk-inserts newline-delimited JSON rows with FORMAT JSONEachRow. */
  insert(sql: string, jsonLines: string): Promise<void>;
  ping(): Promise<boolean>;
}

export class ClickHouseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`clickhouse responded ${status}: ${body.slice(0, 256)}`);
    this.name = "ClickHouseHttpError";
  }
}

export class ClickHouseHttp implements ClickHouseClient {
  constructor(
    private readonly nodes: readonly string[],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async ping(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async query<T>(sql: string, queryParameters: Record<string, string> = {}): Promise<T[]> {
    let lastError: unknown;
    for (const node of this.nodes) {
      try {
        const url = new URL(`http://${node}`);
        const headers: Record<string, string> = {};
        if (url.username !== "" || url.password !== "") {
          headers.authorization = `Basic ${Buffer.from(
            `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          ).toString("base64")}`;
          // undici refuses fetch() on URLs carrying credentials.
          url.username = "";
          url.password = "";
        }
        url.search = `?query=${encodeURIComponent(sql)}`;
        for (const [key, value] of Object.entries(queryParameters)) {
          url.searchParams.append(`param_${key}`, value);
        }
        const response = await this.withTimeout(
          this.fetchImpl(url.toString(), { method: "POST", headers }),
        );
        if (!response.ok) {
          throw new ClickHouseHttpError(response.status, await response.text());
        }
        const text = await response.text();
        if (text.trim() === "") {
          return [];
        }
        return text
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as T);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("no clickhouse nodes configured");
  }

  async insert(sql: string, jsonLines: string): Promise<void> {
    let lastError: unknown;
    for (const node of this.nodes) {
      try {
        const url = new URL(`http://${node}`);
        const headers: Record<string, string> = { "content-type": "text/plain" };
        if (url.username !== "" || url.password !== "") {
          headers.authorization = `Basic ${Buffer.from(
            `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          ).toString("base64")}`;
          url.username = "";
          url.password = "";
        }
        url.search = `?query=${encodeURIComponent(sql)}`;
        const response = await this.withTimeout(
          this.fetchImpl(url.toString(), { method: "POST", body: jsonLines, headers }),
        );
        if (!response.ok) {
          throw new ClickHouseHttpError(response.status, await response.text());
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("no clickhouse nodes configured");
  }

  private withTimeout(promise: Promise<Response>): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("clickhouse query timeout")), this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
