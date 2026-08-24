/**
 * Single-pass SSE tap (G2): forwards raw upstream bytes untouched while
 * incrementally parsing `data:` payloads. Passthrough preserves provider
 * formatting and natural TCP backpressure; parsing exists solely for usage
 * extraction and observability.
 */

export interface SseEvent {
  data: string;
}

const DECODER = new TextDecoder("utf-8");
const ENCODER = new TextEncoder();

export class SseTap {
  private buffer = "";
  readonly events: SseEvent[] = [];

  constructor(
    private readonly onEvent?: (event: SseEvent) => void,
    private readonly maxBufferBytes = 1_048_576,
  ) {}

  /** Feeds a chunk; returns the exact bytes that should be forwarded downstream. */
  push(bytes: Uint8Array): Uint8Array {
    this.buffer += DECODER.decode(bytes, { stream: true });    let boundary = this.buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, "");
      this.buffer = this.buffer.slice(boundary + 1);
      this.handleLine(line);
      boundary = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxBufferBytes) {
      // Pathological upstream; drop buffer rather than grow unbounded.
      this.buffer = "";
    }
    return bytes;
  }

  /** Flushes any decoder-buffered bytes at stream end and parses trailing line. */
  finish(): void {
    const tail = DECODER.decode();
    if (tail) {
      const lastNewline = tail.lastIndexOf("\n");
      if (lastNewline !== -1) {
        this.handleLine(tail.slice(0, lastNewline + 1));
      }
    }
    this.buffer = "";
  }

  private handleLine(line: string): void {
    if (!line.startsWith("data:")) {
      return;
    }
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") {
      return;
    }
    const event: SseEvent = { data };
    this.events.push(event);
    this.onEvent?.(event);
  }
}

/** Encodes an SSE `data:` frame in OpenAI wire format. */
export function encodeSseData(payload: string | null): Uint8Array {
  const frame = payload === null ? "data: [DONE]\n\n" : `data: ${payload}\n\n`;
  return ENCODER.encode(frame);
}
