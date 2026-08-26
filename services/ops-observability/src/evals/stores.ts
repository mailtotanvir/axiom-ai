/**
 * In-memory eval store (tests + Postgres-less dev).
 */

import type {
  EvalResultRow,
  EvalStore,
} from "./store.js";
import type { EvalReport } from "./types.js";

interface StoredRun {
  runId: string;
  tenantId: string;
  datasetName: string;
  datasetVersion: number;
  promptName: string;
  promptVersion: string;
  model: string;
  status: string;
  overallScore: number | null;
  caseCount: number;
  errorCount: number;
  startedAt: Date;
  finishedAt?: Date;
}

export class InMemoryEvalStore implements EvalStore {
  readonly datasets = new Map<string, { version: number; cases: Array<{
    externalId: string;
    vars: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> }>();
  readonly runs = new Map<string, StoredRun>();
  readonly resultRows: EvalResultRow[] = [];

  private counter = 0;

  async createDataset(input: {
    tenantId: string;
    name: string;
    cases: Array<{ externalId: string; vars: Record<string, unknown>; expected: Record<string, unknown> }>;
  }): Promise<{ name: string; version: number; caseCount: number }> {
    const key = `${input.tenantId}/${input.name}`;
    const previous = this.datasets.get(key);
    const version = (previous?.version ?? 0) + 1;
    this.datasets.set(key, { version, cases: input.cases });
    return { name: input.name, version, caseCount: input.cases.length };
  }

  async getDataset(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<{ version: number; cases: Array<{ externalId: string; vars: Record<string, unknown>; expected: Record<string, unknown> }> } | null> {
    const entry = this.datasets.get(`${tenantId}/${name}`);
    if (entry === undefined || (version !== undefined && entry.version !== version)) {
      return null;
    }
    return { version: entry.version, cases: entry.cases };
  }

  async startRun(input: {
    tenantId: string;
    datasetName: string;
    datasetVersion: number;
    promptName: string;
    promptVersion: string;
    model: string;
  }): Promise<string> {
    this.counter += 1;
    const runId = `run-${this.counter}`;
    this.runs.set(runId, {
      runId,
      ...input,
      status: "running",
      overallScore: null,
      caseCount: 0,
      errorCount: 0,
      startedAt: new Date(),
    });
    return runId;
  }

  async finishRun(
    runId: string,
    report: Pick<EvalReport, "status" | "overallScore" | "caseCount" | "errorCount">,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }
    Object.assign(run, report, { finishedAt: new Date() });
  }

  async writeResults(rows: EvalResultRow[]): Promise<void> {
    for (const row of rows) {
      this.resultRows.push(row);
    }
  }

  async latestRun(input: {
    tenantId: string;
    datasetName: string;
    promptName: string;
  }): Promise<{ runId: string; overallScore: number | null; status: string; startedAt: Date } | null> {
    const matches = [...this.runs.values()]
      .filter(
        (run) =>
          run.tenantId === input.tenantId &&
          run.datasetName === input.datasetName &&
          run.promptName === input.promptName &&
          run.status === "completed",
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const run = matches[0];
    return run === undefined
      ? null
      : {
          runId: run.runId,
          overallScore: run.overallScore,
          status: run.status,
          startedAt: run.startedAt,
        };
  }
}
