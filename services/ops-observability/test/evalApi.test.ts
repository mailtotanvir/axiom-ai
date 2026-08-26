/**
 * Route-level tests for the O3 eval API including the CI gate endpoint.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createOpsConfig } from "../src/config.js";
import { InMemoryEvalStore } from "../src/evals/stores.js";
import { EvalRunner, type GatewayChatClient } from "../src/evals/runner.js";
import { InMemoryPromptRegistry } from "../src/prompts/memoryStore.js";
import type { PromptRegistryStore } from "../src/prompts/types.js";

const SECRET = "dev-only-inter-service-secret";
const AUTH = { "x-axiom-internal-secret": SECRET };

function makeHarness(output: string): {
  app: FastifyInstance;
  store: InMemoryEvalStore;
} {
  const store = new InMemoryEvalStore();
  const registry: PromptRegistryStore = new InMemoryPromptRegistry();
  const gateway: GatewayChatClient = { complete: async () => output };
  const runner = new EvalRunner({ evalStore: store, registry, gateway });
  const app = buildApp(
    {
      ...createOpsConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }),
      CLICKHOUSE_NODES: undefined,
      POSTGRES_DB_URI: undefined,
    },
    { registry, evalStore: store, evalRunner: runner },
  );
  return { app, store };
}

describe("eval API", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeAll(() => {
    harness = makeHarness("The capital of France is Paris.");
  });

  afterAll(async () => {
    await harness.app.closeStores();
    await harness.app.close();
  });

  async function seedAndRun(): Promise<void> {
    await harness.app.inject({
      method: "POST",
      url: "/v1/prompts",
      headers: AUTH,
      payload: { tenantId: "acme", name: "capital-qa" },
    });
    await harness.app.inject({
      method: "POST",
      url: "/v1/prompts/capital-qa/versions?tenant=acme",
      headers: AUTH,
      payload: {
        semver: "1.0.0",
        template: "What is the capital of {{country}}?",
        templateSchema: {
          type: "object",
          properties: { country: { type: "string" } },
          required: ["country"],
          additionalProperties: false,
        },
      },
    });
    await harness.app.inject({
      method: "POST",
      url: "/v1/prompts/capital-qa/versions/1.0.0/publish?tenant=acme",
      headers: AUTH,
    });
    await harness.app.inject({
      method: "POST",
      url: "/v1/prompts/capital-qa/versions/1.0.0/promote?tenant=acme",
      headers: AUTH,
      payload: { environment: "development" },
    });

    await harness.app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: {
        tenantId: "acme",
        name: "capitals-golden",
        cases: [
          { externalId: "fr", vars: { country: "France" }, expected: { contains: "Paris" } },
          { externalId: "it", vars: { country: "Italy" }, expected: { contains: "Rome" } },
        ],
      },
    });

    // Only run France so overall score is 1.0 for that case set.
    const run = await harness.app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: AUTH,
      payload: {
        tenantId: "acme",
        dataset: { name: "capitals-golden" },
        prompt: { name: "capital-qa" },
        model: "openai/gpt-oss-120b",
        metrics: [{ type: "contains", weight: 1 }],
        maxCases: 1,
      },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe("completed");
  }

  it("executes a run end-to-end through the API", async () => {
    await seedAndRun();

    const gate = await harness.app.inject({
      method: "GET",
      url: "/v1/evals/gate?tenant=acme&dataset=capitals-golden&prompt=capital-qa&minScore=0.9",
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json()).toMatchObject({ passed: true, score: 1 });
  });

  it("gate returns 412 when the score misses the threshold", async () => {
    const gate = await harness.app.inject({
      method: "GET",
      url: "/v1/evals/gate?tenant=acme&dataset=capitals-golden&prompt=capital-qa&minScore=0.99&maxAgeMinutes=0",
    });
    // maxAgeMinutes=0 forces a freshness failure even though score is 1.
    expect(gate.statusCode).toBe(412);
    expect(gate.json()).toMatchObject({ passed: false, reason: "run too old" });
  });

  it("gate returns 404 envelope when no run exists", async () => {
    const gate = await harness.app.inject({
      method: "GET",
      url: "/v1/evals/gate?tenant=nobody&dataset=nothing&prompt=nowhere&minScore=0.5",
    });
    expect(gate.statusCode).toBe(404);
    expect(gate.json()).toMatchObject({ passed: false });
  });

  it("requires the inter-service secret for dataset creation", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      payload: { tenantId: "acme", name: "x", cases: [{ externalId: "c", vars: {}, expected: {} }] },
    });
    expect(response.statusCode).toBe(401);
  });
});
