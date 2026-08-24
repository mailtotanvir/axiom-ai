/**
 * Deterministic OpenAI-compatible mock provider for tests and load runs.
 * Supports scripted failures (chaos), streaming, usage reporting, and
 * latency injection.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockProviderOptions {
  /** Scripted behavior for the next N requests. */
  behavior?: "ok" | "fail_500" | "rate_limited" | "timeout" | "cut_stream";
}

interface StoredRequest {
  body: Record<string, unknown>;
}

export class MockUpstream {
  readonly requests: StoredRequest[] = [];
  private behaviorQueue: Array<MockProviderOptions["behavior"]> = [];
  private server: http.Server | undefined;
  private latencyMs = 0;

  get url(): string {
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  script(...behaviors: NonNullable<MockProviderOptions["behavior"]>[]): void {
    this.behaviorQueue = [...behaviors];
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        req.on("end", () => {
          void this.handle(req, res, raw);
        });
      });
      this.server.listen(0, "127.0.0.1", resolve);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: string,
  ): Promise<void> {
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    this.requests.push({ body });

    if (this.latencyMs > 0) {
      await sleep(this.latencyMs);
    }
    if (req.headers.authorization !== "Bearer mock-key") {
      res.writeHead(401).end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }

    const behavior = this.behaviorQueue.shift() ?? "ok";
    switch (behavior) {
      case "fail_500":
        res.writeHead(500).end(JSON.stringify({ error: { message: "boom" } }));
        return;
      case "rate_limited":
        res.writeHead(429).end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      case "timeout": {
        // Never respond; the gateway timeout aborts the socket.
        res.socket?.setTimeout(this.latencyMs + 120_000);
        await sleep(110_000).catch(() => undefined);
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
        return;
      }
      default:
        break;
    }

    const streamed = body.stream === true;
    if (!streamed) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from mock!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
      );
      return;
    }

    // Streaming SSE.
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames: string[] = [
      sseFrame({
        id: "chatcmpl-mock",
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }],
      }),
      sseFrame({
        id: "chatcmpl-mock",
        model: body.model,
        choices: [{ index: 0, delta: { content: "lo stream" }, finish_reason: null }],
      }),
      sseFrame({
        id: "chatcmpl-mock",
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      }),
    ];

    if (behavior === "cut_stream") {
      // Emit one frame then destroy the socket mid-stream.
      res.write(frames[0]);
      setTimeout(() => res.destroy(), 20);
      return;
    }

    for (const frame of frames) {
      await sleep(10);
      res.write(frame);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
