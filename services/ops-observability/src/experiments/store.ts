/**
 * Experiment storage (O4). Definitions and assignment/outcome events in
 * Postgres via Prisma; per-request assignments are high-volume append rows.
 */

import { PrismaClient } from "@prisma/client";

import type {
  AssignmentEvent,
  ExperimentArmDto,
  ExperimentDto,
  ExperimentStatus,
  OutcomeEvent,
} from "./types.js";

export interface ReportRow {
  arm: string;
  keyHash: string;
  value: number | null;
}

export interface ExperimentStore {
  createExperiment(input: {
    tenantId: string;
    name: string;
    status?: ExperimentStatus;
    targetingModels?: string[];
    arms: ExperimentArmDto[];
  }): Promise<ExperimentDto>;
  getExperiment(tenantId: string, id: string): Promise<ExperimentDto | null>;
  listExperiments(tenantId: string, status?: ExperimentStatus): Promise<ExperimentDto[]>;
  listRunning(): Promise<ExperimentDto[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: ExperimentStatus,
  ): Promise<ExperimentDto | null>;

  /** Existence probe for the cross-tenant ingest endpoints. */
  exists(experimentId: string): Promise<boolean>;

  recordAssignment(event: AssignmentEvent): Promise<void>;
  recordOutcome(event: OutcomeEvent): Promise<void>;

  /**
   * One row per outcome joined to the most recent assignment of the same
   * key; `value` is null for assigned keys without outcomes.
   */
  reportRows(experimentId: string): Promise<ReportRow[]>;
}

function toDto(experiment: {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  targetingModels: unknown;
  createdAt: Date;
  arms: Array<{
    name: string;
    weight: number;
    model: string | null;
    promptName: string | null;
    promptSemver: string | null;
  }>;
}): ExperimentDto {
  return {
    id: experiment.id,
    tenantId: experiment.tenantId,
    name: experiment.name,
    status: experiment.status as ExperimentStatus,
    ...(Array.isArray(experiment.targetingModels) && experiment.targetingModels.length > 0
      ? { targetingModels: experiment.targetingModels as string[] }
      : {}),
    arms: experiment.arms.map((arm) => ({
      name: arm.name,
      weight: arm.weight,
      ...(arm.model !== null ? { model: arm.model } : {}),
      ...(arm.promptName !== null
        ? { prompt: { name: arm.promptName, ...(arm.promptSemver !== null ? { semver: arm.promptSemver } : {}) } }
        : {}),
    })),
    createdAt: experiment.createdAt.toISOString(),
  };
}

const experimentInclude = {
  arms: { orderBy: { name: "asc" as const } },
} as const;

export class PrismaExperimentStore implements ExperimentStore {
  private readonly prisma: PrismaClient;

  constructor(datasourceUrl?: string) {
    this.prisma =
      datasourceUrl !== undefined ? new PrismaClient({ datasourceUrl }) : new PrismaClient();
  }

  async createExperiment(input: {
    tenantId: string;
    name: string;
    status?: ExperimentStatus;
    targetingModels?: string[];
    arms: ExperimentArmDto[];
  }): Promise<ExperimentDto> {
    const created = await this.prisma.experiment.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        status: input.status ?? "draft",
        targetingModels:
          input.targetingModels !== undefined ? (input.targetingModels as never) : undefined,
        arms: {
          create: input.arms.map((arm) => ({
            name: arm.name,
            weight: arm.weight,
            model: arm.model,
            promptName: arm.prompt?.name,
            promptSemver: arm.prompt?.semver,
          })),
        },
      },
      include: experimentInclude,
    });
    return toDto(created);
  }

  async getExperiment(tenantId: string, id: string): Promise<ExperimentDto | null> {
    const found = await this.prisma.experiment.findFirst({
      where: { tenantId, id },
      include: experimentInclude,
    });
    return found === null ? null : toDto(found);
  }

  async listExperiments(tenantId: string, status?: ExperimentStatus): Promise<ExperimentDto[]> {
    const rows = await this.prisma.experiment.findMany({
      where: { tenantId, ...(status !== undefined ? { status } : {}) },
      orderBy: { createdAt: "asc" },
      include: experimentInclude,
    });
    return rows.map(toDto);
  }

  async listRunning(): Promise<ExperimentDto[]> {
    const rows = await this.prisma.experiment.findMany({
      where: { status: "running" },
      orderBy: { createdAt: "asc" },
      include: experimentInclude,
    });
    return rows.map(toDto);
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: ExperimentStatus,
  ): Promise<ExperimentDto | null> {
    const existing = await this.getExperiment(tenantId, id);
    if (existing === null) {
      return null;
    }
    const updated = await this.prisma.experiment.update({
      where: { id },
      data: { status },
      include: experimentInclude,
    });
    return toDto(updated);
  }

  async exists(experimentId: string): Promise<boolean> {
    const found = await this.prisma.experiment.findUnique({
      where: { id: experimentId },
      select: { id: true },
    });
    return found !== null;
  }

  async recordAssignment(event: AssignmentEvent): Promise<void> {
    await this.prisma.experimentAssignment.create({
      data: {
        experimentId: event.experimentId,
        armName: event.arm,
        keyHash: event.keyHash,
        requestId: event.requestId,
      },
    });
  }

  async recordOutcome(event: OutcomeEvent): Promise<void> {
    await this.prisma.experimentOutcome.create({
      data: {
        experimentId: event.experimentId,
        keyHash: event.keyHash,
        value: event.value,
      },
    });
  }

  async reportRows(experimentId: string): Promise<ReportRow[]> {
    const [assignments, outcomes] = await Promise.all([
      this.prisma.experimentAssignment.findMany({
        where: { experimentId },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.experimentOutcome.findMany({
        where: { experimentId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Latest assignment before an outcome owns its attribution; keys with
    // assignments but no outcomes still count toward reach (null value).
    const armByKey = new Map<string, string>();
    for (const assignment of assignments) {
      armByKey.set(assignment.keyHash, assignment.armName);
    }
    const rows: ReportRow[] = [];
    for (const outcome of outcomes) {
      let arm: string | undefined;
      for (const assignment of assignments) {
        if (assignment.keyHash === outcome.keyHash && assignment.createdAt <= outcome.createdAt) {
          arm = assignment.armName;
        }
      }
      if (arm !== undefined) {
        rows.push({ arm, keyHash: outcome.keyHash, value: outcome.value });
      }
    }
    for (const [keyHash, arm] of armByKey) {
      if (!rows.some((row) => row.keyHash === keyHash)) {
        rows.push({ arm, keyHash, value: null });
      }
    }
    return rows;
  }
}
