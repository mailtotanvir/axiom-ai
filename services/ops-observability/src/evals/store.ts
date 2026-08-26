/**
 * Eval storage (O3). Golden datasets and run summaries in Postgres via
 * Prisma; per-case metric rows go to ClickHouse through the sink below.
 */

import { PrismaClient } from "@prisma/client";

import type { EvalReport } from "./types.js";

export interface DatasetCase {
  externalId: string;
  vars: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface EvalStore {
  createDataset(input: {
    tenantId: string;
    name: string;
    cases: DatasetCase[];
  }): Promise<{ name: string; version: number; caseCount: number }>;
  getDataset(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<{ version: number; cases: DatasetCase[] } | null>;
  startRun(input: {
    tenantId: string;
    datasetName: string;
    datasetVersion: number;
    promptName: string;
    promptVersion: string;
    model: string;
  }): Promise<string>;
  finishRun(runId: string, report: Pick<EvalReport, "status" | "overallScore" | "caseCount" | "errorCount">): Promise<void>;
  writeResults(rows: EvalResultRow[]): Promise<void>;
  latestRun(input: {
    tenantId: string;
    datasetName: string;
    promptName: string;
  }): Promise<{ runId: string; overallScore: number | null; status: string; startedAt: Date } | null>;
}

export interface EvalResultRow {
  timestamp: string;
  runId: string;
  tenantId: string;
  datasetName: string;
  datasetVersion: number;
  promptName: string;
  promptVersion: string;
  model: string;
  caseId: string;
  metric: string;
  score: number;
  passed: boolean;
  detail?: string;
}

export class PrismaEvalStore implements EvalStore {
  private readonly prisma: PrismaClient;

  constructor(datasourceUrl?: string) {
    this.prisma =
      datasourceUrl !== undefined ? new PrismaClient({ datasourceUrl }) : new PrismaClient();
  }

  async createDataset(input: {
    tenantId: string;
    name: string;
    cases: DatasetCase[];
  }): Promise<{ name: string; version: number; caseCount: number }> {
    const latest = await this.prisma.goldenDataset.findFirst({
      where: { tenantId: input.tenantId, name: input.name },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;
    const created = await this.prisma.goldenDataset.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        version,
        cases: {
          create: input.cases.map((testCase) => ({
            externalId: testCase.externalId,
            vars: testCase.vars as never,
            expected: testCase.expected as never,
          })),
        },
      },
      include: { cases: true },
    });
    return { name: created.name, version: created.version, caseCount: created.cases.length };
  }

  async getDataset(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<{ version: number; cases: DatasetCase[] } | null> {
    const dataset = await this.prisma.goldenDataset.findFirst({
      where: { tenantId, name, ...(version !== undefined ? { version } : {}) },
      orderBy: { version: "desc" },
      include: { cases: { orderBy: { externalId: "asc" } } },
    });
    if (dataset === null) {
      return null;
    }
    return {
      version: dataset.version,
      cases: dataset.cases.map((goldenCase) => ({
        externalId: goldenCase.externalId,
        vars: goldenCase.vars as Record<string, unknown>,
        expected: goldenCase.expected as Record<string, unknown>,
      })),
    };
  }

  async startRun(input: {
    tenantId: string;
    datasetName: string;
    datasetVersion: number;
    promptName: string;
    promptVersion: string;
    model: string;
  }): Promise<string> {
    const created = await this.prisma.evalRun.create({ data: input });
    return created.id;
  }

  async finishRun(
    runId: string,
    report: Pick<EvalReport, "status" | "overallScore" | "caseCount" | "errorCount">,
  ): Promise<void> {
    await this.prisma.evalRun.update({
      where: { id: runId },
      data: {
        status: report.status,
        overallScore: report.overallScore,
        caseCount: report.caseCount,
        errorCount: report.errorCount,
        finishedAt: new Date(),
      },
    });
  }

  /** No-op for the Postgres store; results persist in ClickHouse. */
  async writeResults(_rows: EvalResultRow[]): Promise<void> {
    /* rows are persisted by the ClickHouse sink */
  }

  async latestRun(input: {
    tenantId: string;
    datasetName: string;
    promptName: string;
  }): Promise<{ runId: string; overallScore: number | null; status: string; startedAt: Date } | null> {
    return this.prisma.evalRun.findFirst({
      where: {
        tenantId: input.tenantId,
        datasetName: input.datasetName,
        promptName: input.promptName,
        status: "completed",
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, overallScore: true, status: true, startedAt: true },
    })
      .then((run) =>
        run === null
          ? null
          : { runId: run.id, overallScore: run.overallScore, status: run.status, startedAt: run.startedAt },
      );
  }
}
