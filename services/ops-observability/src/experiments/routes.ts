/**
 * A/B experimentation HTTP API (O4): experiment CRUD + lifecycle, the
 * rules feed the gateway polls, assignment/outcome ingestion, and the
 * statistical report (win probability, confidence intervals).
 */

import type { FastifyInstance } from "fastify";

import { errors } from "@tanvir1971/core";

import type { PromptRegistryStore } from "../prompts/types.js";
import { summarize, winProbabilities } from "./stats.js";
import type { ExperimentStore } from "./store.js";
import type {
  ExperimentDto,
  ExperimentRule,
  ExperimentStatus,
  RulesResponse,
} from "./types.js";
import {
  assignmentSchema,
  createExperimentSchema,
  EXPERIMENT_STATUSES,
  outcomeSchema,
} from "./types.js";

export interface ExperimentRouteDeps {
  store: ExperimentStore;
  registry: PromptRegistryStore;
  internalSecret: string;
}

/** Serving preference when an arm pins no semver (live traffic first). */
const SERVE_ENVIRONMENT_PREFERENCE = ["production", "staging", "development"] as const;

/** Report precision; CIs and probabilities carry 4 decimals at most. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function registerExperimentRoutes(
  app: FastifyInstance,
  deps: ExperimentRouteDeps,
): void {
  const requireSecret = (request: { headers: Record<string, unknown> }): void => {
    if (request.headers["x-axiom-internal-secret"] !== deps.internalSecret) {
      throw errors.unauthenticated("Missing or invalid inter-service secret.");
    }
  };

  app.post("/v1/experiments", async (request, reply) => {
    requireSecret(request);
    const parsed = createExperimentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    const created = await deps.store.createExperiment({
      tenantId: parsed.data.tenantId,
      name: parsed.data.name,
      ...(parsed.data.targetingModels !== undefined
        ? { targetingModels: parsed.data.targetingModels }
        : {}),
      arms: parsed.data.arms,
    });
    return reply.status(201).send({ experiment: created });
  });

  app.get<{
    Querystring: { tenant?: string; status?: string };
  }>("/v1/experiments", async (request, reply) => {
    requireSecret(request);
    const tenant = request.query.tenant;
    if (!tenant) {
      return reply.status(400).send(errors.validationFailed([{ path: "tenant", message: "required" }]));
    }
    let status: ExperimentStatus | undefined;
    if (request.query.status !== undefined) {
      if (!(EXPERIMENT_STATUSES as readonly string[]).includes(request.query.status)) {
        return reply
          .status(400)
          .send(errors.validationFailed([{ path: "status", message: "invalid status" }]));
      }
      status = request.query.status as ExperimentStatus;
    }
    const experiments = await deps.store.listExperiments(tenant, status);
    return { experiments };
  });

  app.get<{ Params: { id: string }; Querystring: { tenant?: string } }>(
    "/v1/experiments/:id",
    async (request, reply) => {
      requireSecret(request);
      const tenant = request.query.tenant;
      if (!tenant) {
        return reply
          .status(400)
          .send(errors.validationFailed([{ path: "tenant", message: "required" }]));
      }
      const experiment = await deps.store.getExperiment(tenant, request.params.id);
      if (experiment === null) {
        return reply.status(404).send(errors.notFound("Experiment").toJSON());
      }
      return { experiment };
    },
  );

  // Lifecycle transitions: draft → running → completed; archive anywhere.
  for (const [action, from, to] of [
    ["start", ["draft"], "running"],
    ["stop", ["running"], "completed"],
    ["archive", ["draft", "completed"], "archived"],
  ] as const) {
    app.post<{ Params: { id: string }; Querystring: { tenant?: string } }>(
      `/v1/experiments/:id/${action}`,
      async (request, reply) => {
        requireSecret(request);
        const tenant = request.query.tenant;
        if (!tenant) {
          return reply
            .status(400)
            .send(errors.validationFailed([{ path: "tenant", message: "required" }]));
        }
        const experiment = await deps.store.getExperiment(tenant, request.params.id);
        if (experiment === null) {
          return reply.status(404).send(errors.notFound("Experiment").toJSON());
        }
        if (!(from as readonly string[]).includes(experiment.status)) {
          return reply.status(409).send(
            errors.conflict(
              `cannot ${action} experiment in status '${experiment.status}'`,
            ).toJSON(),
          );
        }
        const updated = await deps.store.updateStatus(
          tenant,
          request.params.id,
          to as ExperimentStatus,
        );
        return { experiment: updated };
      },
    );
  }

  /**
   * Rules feed consumed by the gateway (poll + cache). Arm prompt refs are
   * resolved here so the gateway never talks to the registry directly.
   */
  app.get("/v1/rules/experiments", async () => {
    const running = await deps.store.listRunning();
    const rules: ExperimentRule[] = [];
    const unresolved: RulesResponse["unresolved"] = [];

    for (const experiment of running) {
      const rule: ExperimentRule = {
        experimentId: experiment.id,
        tenantId: experiment.tenantId,
        name: experiment.name,
        salt: experiment.id,
        ...(experiment.targetingModels !== undefined
          ? { targetingModels: experiment.targetingModels }
          : {}),
        arms: [],
      };
      let usable = true;
      for (const arm of experiment.arms) {
        if (arm.prompt === undefined) {
          rule.arms.push({ name: arm.name, weight: arm.weight, model: arm.model });
          continue;
        }
        const template = await resolveTemplate(deps.registry, experiment, arm);
        if (template === null) {
          unresolved.push({
            experimentId: experiment.id,
            arm: arm.name,
            reason: `no published prompt version for '${arm.prompt.name}'${
              arm.prompt.semver !== undefined ? `@${arm.prompt.semver}` : ""
            }`,
          });
          usable = false;
          break;
        }
        rule.arms.push({
          name: arm.name,
          weight: arm.weight,
          model: arm.model,
          template,
        });
      }
      if (usable) {
        rules.push(rule);
      }
    }
    const response: RulesResponse = { rules, unresolved };
    return response;
  });

  app.post<{ Params: { id: string } }>("/v1/experiments/:id/assignments", async (request, reply) => {
    requireSecret(request);
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    if (!(await deps.store.exists(request.params.id))) {
      return reply.status(404).send(errors.notFound("Experiment").toJSON());
    }
    await deps.store.recordAssignment({
      experimentId: request.params.id,
      arm: parsed.data.arm,
      keyHash: parsed.data.keyHash,
      ...(parsed.data.requestId !== undefined ? { requestId: parsed.data.requestId } : {}),
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/experiments/:id/outcomes", async (request, reply) => {
    requireSecret(request);
    const parsed = outcomeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    if (!(await deps.store.exists(request.params.id))) {
      return reply.status(404).send(errors.notFound("Experiment").toJSON());
    }
    await deps.store.recordOutcome({
      experimentId: request.params.id,
      keyHash: parsed.data.keyHash,
      value: parsed.data.value,
    });
    return reply.status(204).send();
  });

  app.get<{
    Params: { id: string };
    Querystring: { tenant?: string };
  }>("/v1/experiments/:id/report", async (request, reply) => {
    requireSecret(request);
    const tenant = request.query.tenant;
    if (!tenant) {
      return reply
        .status(400)
        .send(errors.validationFailed([{ path: "tenant", message: "required" }]));
    }
    const experiment = await deps.store.getExperiment(tenant, request.params.id);
    if (experiment === null) {
      return reply.status(404).send(errors.notFound("Experiment").toJSON());
    }

    const rows = await deps.store.reportRows(experiment.id);
    const assignedKeys = new Map<string, Set<string>>();
    const valuesByArm = new Map<string, number[]>();
    for (const arm of experiment.arms) {
      assignedKeys.set(arm.name, new Set());
      valuesByArm.set(arm.name, []);
    }
    for (const row of rows) {
      assignedKeys.get(row.arm)?.add(row.keyHash);
      if (row.value !== null) {
        valuesByArm.get(row.arm)?.push(row.value);
      }
    }

    const summaries: Record<string, ReturnType<typeof summarize>> = {};
    const armReports = experiment.arms.map((arm) => {
      const summary = summarize(valuesByArm.get(arm.name) ?? []);
      summaries[arm.name] = summary;
      return {
        ...arm,
        assignments: assignedKeys.get(arm.name)?.size ?? 0,
        outcomes: {
          n: summary.n,
          mean: round(summary.mean),
          stdErr: round(summary.stdErr),
          ci95: [round(summary.ci95[0]), round(summary.ci95[1])] as [number, number],
        },
      };
    });

    const probabilities = winProbabilities(summaries);
    const winnerProbabilities = Object.fromEntries(
      Object.entries(probabilities).map(([arm, probability]) => [arm, round(probability)]),
    );

    const ranked = [...experiment.arms]
      .map((arm) => ({ arm: arm.name, probability: probabilities[arm.name] ?? 0 }))
      .sort((a, b) => b.probability - a.probability);
    const leader = ranked[0];
    const leaderN = summaries[leader?.arm ?? ""]?.n ?? 0;
    const recommendation =
      leader !== undefined && leader.probability >= 0.9 && leaderN >= 30
        ? `ship:${leader.arm}`
        : "keep_running";

    return buildReport(experiment, armReports, winnerProbabilities, recommendation);
  });

  function buildReport(
    experiment: ExperimentDto,
    armReports: unknown[],
    winnerProbabilities: Record<string, number>,
    recommendation: string,
  ) {
    return {
      experiment: {
        id: experiment.id,
        tenantId: experiment.tenantId,
        name: experiment.name,
        status: experiment.status,
      },
      arms: armReports,
      winnerProbabilities,
      recommendation,
    };
  }
}

/**
 * Resolves the template an arm serves: pinned semver must be published;
 * otherwise the highest-preference environment with a promotion wins.
 */
async function resolveTemplate(
  registry: PromptRegistryStore,
  experiment: ExperimentDto,
  arm: ExperimentDto["arms"][number],
): Promise<string | null> {
  if (arm.prompt === undefined) {
    return null;
  }
  const versions = await registry.listVersions(experiment.tenantId, arm.prompt.name);
  if (arm.prompt.semver !== undefined) {
    const pinned = versions.find((version) => version.semver === arm.prompt?.semver);
    return pinned !== undefined && pinned.status === "published" ? pinned.template : null;
  }
  const published = versions.filter((version) => version.status === "published");
  for (const environment of SERVE_ENVIRONMENT_PREFERENCE) {
    const candidate = published.find((version) => version.environments.includes(environment));
    if (candidate !== undefined) {
      return candidate.template;
    }
  }
  return null;
}
