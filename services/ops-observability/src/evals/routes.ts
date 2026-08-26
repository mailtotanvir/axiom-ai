/**
 * Eval engine HTTP API (O3): dataset management, run execution, and the
 * CI-facing regression-gate endpoint.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "@axiom-ai/core";

import type { EvalRunner } from "./runner.js";
import type { EvalStore } from "./store.js";
import {
  createDatasetSchema,
  startEvalRunSchema,
} from "./types.js";
import type { PromptRegistryStore } from "../prompts/types.js";

export interface EvalRouteDeps {
  store: EvalStore;
  runner: EvalRunner;
  registry: PromptRegistryStore;
  internalSecret: string;
}

const DOMAIN_ERROR_STATUS: Record<string, number> = {
  DatasetNotFound: 404,
  PromptVersionNotFound: 404,
  PromptNotPublished: 409,
};

export function registerEvalRoutes(app: FastifyInstance, deps: EvalRouteDeps): void {
  const requireSecret = (request: { headers: Record<string, unknown> }): void => {
    if (request.headers["x-axiom-internal-secret"] !== deps.internalSecret) {
      throw errors.unauthenticated("Missing or invalid inter-service secret.");
    }
  };

  app.post<{ Querystring: { tenant?: string } }>("/v1/evals/datasets", async (request, reply) => {
    requireSecret(request);
    const parsed = createDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    const created = await deps.store.createDataset({
      tenantId: parsed.data.tenantId,
      name: parsed.data.name,
      cases: parsed.data.cases.map((testCase) => ({
        externalId: testCase.externalId,
        vars: testCase.vars as Record<string, unknown>,
        expected: testCase.expected as Record<string, unknown>,
      })),
    });
    return reply.status(201).send({ dataset: created });
  });

  app.get<{
    Querystring: { tenant?: string; name?: string; version?: string };
  }>("/v1/evals/datasets", async (request, reply) => {
    const tenant = request.query.tenant;
    const name = request.query.name;
    if (!tenant || !name) {
      return reply
        .status(400)
        .send(errors.validationFailed([{ path: "tenant,name", message: "required" }]));
    }
    const dataset = await deps.store.getDataset(
      tenant,
      name,
      request.query.version !== undefined ? Number(request.query.version) : undefined,
    );
    if (dataset === null) {
      return reply.status(404).send(errors.notFound("Golden dataset").toJSON());
    }
    return { dataset };
  });

  app.post("/v1/evals/runs", async (request, reply) => {
    requireSecret(request);
    const parsed = startEvalRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    try {
      return await deps.runner.run(parsed.data);
    } catch (error) {
      const status = DOMAIN_ERROR_STATUS[error instanceof Error ? error.name : ""];
      if (status !== undefined) {
        return reply.status(status).send(errors.conflict((error as Error).message).toJSON());
      }
      throw error;
    }
  });

  /**
   * Regression gate for CI: pass when the latest completed run for
   * (dataset, prompt) scores at least `minScore` and is fresh enough.
   */
  app.get<{
    Querystring: {
      tenant?: string;
      dataset?: string;
      prompt?: string;
      minScore?: string;
      maxAgeMinutes?: string;
    };
  }>("/v1/evals/gate", async (request, reply) => {
    const { tenant, dataset, prompt } = request.query;
    const minScoreRaw = Number(request.query.minScore ?? "1");
    const maxAgeMinutes = Number(request.query.maxAgeMinutes ?? "1440");
    if (!tenant || !dataset || !prompt || !Number.isFinite(minScoreRaw)) {
      return reply.status(400).send(
        errors.validationFailed([
          ...(!tenant ? [{ path: "tenant", message: "required" }] : []),
          ...(!dataset ? [{ path: "dataset", message: "required" }] : []),
          ...(!prompt ? [{ path: "prompt", message: "required" }] : []),
          ...(Number.isFinite(minScoreRaw)
            ? []
            : [{ path: "minScore", message: "must be a number between 0 and 1" }]),
        ]),
      );
    }
    const run = await deps.store.latestRun({ tenantId: tenant, datasetName: dataset, promptName: prompt });
    if (run === null) {
      return reply.status(404).send({
        passed: false,
        reason: "no completed eval run found",
      });
    }
    const ageMinutes = (Date.now() - run.startedAt.getTime()) / 60_000;
    const score = run.overallScore ?? 0;
    const passed =
      ageMinutes <= maxAgeMinutes && score >= Math.min(Math.max(minScoreRaw, 0), 1);
    return reply.status(passed ? 200 : 412).send({
      passed,
      score,
      requiredMinScore: minScoreRaw,
      runId: run.runId,
      startedAt: run.startedAt.toISOString(),
      ageMinutes: Math.round(ageMinutes),
      ...(passed ? {} : { reason: ageMinutes > maxAgeMinutes ? "run too old" : "score below threshold" }),
    });
  });
}
