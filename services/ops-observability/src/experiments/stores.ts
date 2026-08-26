/**
 * In-memory experiment store (tests + Postgres-less dev).
 */

import type {
  AssignmentEvent,
  ExperimentArmDto,
  ExperimentDto,
  ExperimentStatus,
  OutcomeEvent,
} from "./types.js";
import type { ExperimentStore, ReportRow } from "./store.js";

interface StoredExperiment extends ExperimentDto {
  createdAtMs: number;
}

export class InMemoryExperimentStore implements ExperimentStore {
  readonly experiments = new Map<string, StoredExperiment>();
  readonly assignments: Array<AssignmentEvent & { experimentId: string; at: Date }> = [];
  readonly outcomes: Array<OutcomeEvent & { experimentId: string; at: Date }> = [];

  private counter = 0;

  async createExperiment(input: {
    tenantId: string;
    name: string;
    status?: ExperimentStatus;
    targetingModels?: string[];
    arms: ExperimentArmDto[];
  }): Promise<ExperimentDto> {
    this.counter += 1;
    const id = `exp-${this.counter}`;
    const now = new Date();
    const stored: StoredExperiment = {
      id,
      tenantId: input.tenantId,
      name: input.name,
      status: input.status ?? "draft",
      ...(input.targetingModels !== undefined ? { targetingModels: input.targetingModels } : {}),
      arms: input.arms.map((arm) => ({ ...arm })),
      createdAt: now.toISOString(),
      createdAtMs: now.getTime(),
    };
    this.experiments.set(id, stored);
    return this.clone(stored);
  }

  async getExperiment(tenantId: string, id: string): Promise<ExperimentDto | null> {
    const found = this.experiments.get(id);
    if (found === undefined || found.tenantId !== tenantId) {
      return null;
    }
    return this.clone(found);
  }

  async listExperiments(tenantId: string, status?: ExperimentStatus): Promise<ExperimentDto[]> {
    return [...this.experiments.values()]
      .filter(
        (experiment) =>
          experiment.tenantId === tenantId &&
          (status === undefined || experiment.status === status),
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((experiment) => this.clone(experiment));
  }

  async listRunning(): Promise<ExperimentDto[]> {
    return [...this.experiments.values()]
      .filter((experiment) => experiment.status === "running")
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((experiment) => this.clone(experiment));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: ExperimentStatus,
  ): Promise<ExperimentDto | null> {
    const found = await this.getExperiment(tenantId, id);
    if (found === null) {
      return null;
    }
    const stored = this.experiments.get(id)!;
    stored.status = status;
    return this.clone(stored);
  }

  async exists(experimentId: string): Promise<boolean> {
    return this.experiments.has(experimentId);
  }

  async recordAssignment(event: AssignmentEvent): Promise<void> {
    this.assignments.push({ ...event, experimentId: event.experimentId, at: new Date() });
  }

  async recordOutcome(event: OutcomeEvent): Promise<void> {
    this.outcomes.push({ ...event, experimentId: event.experimentId, at: new Date() });
  }

  async reportRows(experimentId: string): Promise<ReportRow[]> {
    const assignments = this.assignments
      .filter((event) => event.experimentId === experimentId)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const outcomes = this.outcomes.filter((event) => event.experimentId === experimentId);

    const armByKey = new Map<string, string>();
    for (const assignment of assignments) {
      armByKey.set(assignment.keyHash, assignment.arm);
    }
    const rows: ReportRow[] = [];
    for (const outcome of outcomes) {
      let arm: string | undefined;
      for (const assignment of assignments) {
        if (assignment.keyHash === outcome.keyHash && assignment.at <= outcome.at) {
          arm = assignment.arm;
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

  private clone(experiment: StoredExperiment): ExperimentDto {
    const { createdAtMs: _createdAtMs, ...rest } = experiment;
    return { ...rest, arms: rest.arms.map((arm) => ({ ...arm })) };
  }
}
