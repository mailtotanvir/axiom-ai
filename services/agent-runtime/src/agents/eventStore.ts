/**
 * Event-sourced run log (A2). Every orchestrator step appends an immutable
 * event; a killed worker replays the log and continues from the last
 * durable event, which is what makes BullMQ retries idempotent.
 */

import { Pool } from "pg";

import type { RunEvent, RunEventType, RunState } from "./types.js";

export interface RunEventStore {
  append(event: Omit<RunEvent, "seq"> & { seq?: number }): Promise<RunEvent>;
  list(runId: string): Promise<RunEvent[]>;
  close?(): Promise<void>;
}

export function deriveState(events: RunEvent[]): {
  state: RunState;
  steps: number;
  tokensUsed: number;
  failureReason?: string;
  output?: string;
} {
  let steps = 0;
  let tokensUsed = 0;
  let state: RunState = events.length > 0 ? "running" : "queued";
  let failureReason: string | undefined;
  let output: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case "run.started":
        state = "running";
        break;
      case "step.llm": {
        steps += 1;
        const usage = (event.data as { usage?: { promptTokens?: number; completionTokens?: number } })
          .usage;
        tokensUsed += (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
        if (state !== "awaiting_approval") {
          state = "running";
        }
        break;
      }
      case "approval.requested":
        state = "awaiting_approval";
        break;
      case "approval.granted":
        state = "running";
        break;
      case "run.completed":
        state = "completed";
        output = (event.data as { output?: string }).output;
        break;
      case "run.failed":
        state = "failed";
        failureReason = (event.data as { reason?: string }).reason;
        break;
      default:
        break;
    }
  }
  return { state, steps, tokensUsed, failureReason, output };
}

export class InMemoryRunEventStore implements RunEventStore {
  private readonly byRun = new Map<string, RunEvent[]>();
  private seq = 0;

  async append(event: Omit<RunEvent, "seq"> & { seq?: number }): Promise<RunEvent> {
    const stored: RunEvent = {
      ...event,
      seq: event.seq ?? ++this.seq,
    };
    const list = this.byRun.get(stored.runId) ?? [];
    // Replay safety: appending the same step twice is ignored.
    if (list.some((existing) => existing.seq === stored.seq)) {
      return stored;
    }
    list.push(stored);
    this.byRun.set(stored.runId, list);
    return stored;
  }

  async list(runId: string): Promise<RunEvent[]> {
    return [...(this.byRun.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}

export class PostgresRunEventStore implements RunEventStore {
  private readonly pool: Pool;
  private migrated = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_run_events (
        run_id     TEXT        NOT NULL,
        seq        INTEGER     NOT NULL,
        type       TEXT        NOT NULL,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        data       JSONB       NOT NULL DEFAULT '{}',
        PRIMARY KEY (run_id, seq)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS agent_run_events_run_idx
        ON agent_run_events (run_id)
    `);
    this.migrated = true;
  }

  async append(event: Omit<RunEvent, "seq"> & { seq?: number }): Promise<RunEvent> {
    if (!this.migrated) {
      await this.migrate();
    }
    // Sequence is derived from the current max so concurrent writers on the
    // same run stay ordered without locks.
    const result = await this.pool.query<{ seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_run_events WHERE run_id = $1`,
      [event.runId],
    );
    const seq = event.seq ?? Number(result.rows[0]?.seq ?? 1);
    const inserted = await this.pool.query(
      `INSERT INTO agent_run_events (run_id, seq, type, at, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [event.runId, seq, event.type, event.at, JSON.stringify(event.data ?? {})],
    );
    if (inserted.rowCount === 0) {
      // Idempotent replay: the event already exists.
      return { ...event, seq };
    }
    return { ...event, seq };
  }

  async list(runId: string): Promise<RunEvent[]> {
    if (!this.migrated) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT seq, type, at, data FROM agent_run_events WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return result.rows.map((row) => ({
      seq: Number(row.seq),
      runId,
      type: String(row.type) as RunEventType,
      at: new Date(row.at as string).toISOString(),
      data: row.data as unknown,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
