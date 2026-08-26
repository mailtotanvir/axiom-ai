/**
 * O3 metric scorers and the full eval-run pipeline against a scripted
 * gateway double.
 */

import { describe, expect, it } from "vitest";

import { scoreCase } from "../src/evals/metrics.js";
import { EvalRunner, type GatewayChatClient } from "../src/evals/runner.js";
import { InMemoryEvalStore } from "../src/evals/stores.js";
import { InMemoryPromptRegistry } from "../src/prompts/memoryStore.js";
import type { PromptRegistryStore } from "../src/prompts/types.js";
import type { StartEvalRunInput } from "../src/evals/types.js";

describe("metric scorers", () => {
  it("exact match is whitespace/punctuation tolerant", async () => {
    const outcomes = await scoreCase(["exact"], {
      output: "  The answer\nis PARIS ",
      expectation: { outputText: "the answer is paris" },
    });
    expect(outcomes.exact!.passed).toBe(true);
    expect(outcomes.exact!.score).toBe(1);
  });

  it("contains, regex, and json_path_equals behave deterministically", async () => {
    const contains = await scoreCase(["contains"], {
      output: "Refund approved within 7 days.",
      expectation: { contains: "refund" },
    });
    expect(contains.contains!.passed).toBe(true);

    const regex = await scoreCase(["regex"], {
      output: "Order #12345 shipped",
      expectation: { pattern: "Order #\\d+ shipped" },
    });
    expect(regex.regex!.passed).toBe(true);

    const jsonOk = await scoreCase(["json_path_equals"], {
      output: '{"sentiment":"positive","confidence":0.9}',
      expectation: { jsonPath: "sentiment", jsonValue: "positive" },
    });
    expect(jsonOk.json_path_equals!.passed).toBe(true);

    const jsonBad = await scoreCase(["json_path_equals"], {
      output: "not json at all",
      expectation: { jsonPath: "a", jsonValue: 1 },
    });
    expect(jsonBad.json_path_equals!.passed).toBe(false);
  });

  it("llm_judge uses the injected judge and applies a 0.7 threshold", async () => {
    const good = await scoreCase(["llm_judge"], {
      output: "Paris is the capital of France.",
      expectation: { criterion: "Is this factually correct?" },
      judge: async () => 0.95,
    });
    expect(good.llm_judge!.passed).toBe(true);
    expect(good.llm_judge!.score).toBe(0.95);

    const weak = await scoreCase(["llm_judge"], {
      output: "Totally unrelated text.",
      expectation: { criterion: "Is this factually correct?" },
      judge: async () => 0.2,
    });
    expect(weak.llm_judge!.passed).toBe(false);
    expect(weak.llm_judge!.score).toBe(0.2);
  });
});

describe("EvalRunner end-to-end", () => {
  function makeRunner(outputs: string[]): { runner: EvalRunner; store: InMemoryEvalStore; registry: PromptRegistryStore } {
    const store = new InMemoryEvalStore();
    const registry = new InMemoryPromptRegistry();
    let call = 0;
    const gateway: GatewayChatClient = {
      complete: async () => outputs[Math.min(call++, outputs.length - 1)]!,
    };
    return { store, registry, runner: new EvalRunner({ evalStore: store, registry, gateway }) };
  }

  async function seed(registry: PromptRegistryStore): Promise<void> {
    await registry.createPrompt({ tenantId: "acme", name: "capital-qa" });
    await registry.createVersion("acme", "capital-qa", {
      semver: "1.0.0",
      template: "What is the capital of {{country}}?",
    });
    await registry.publish("acme", "capital-qa", "1.0.0");
    await registry.promote("acme", "capital-qa", "1.0.0", "development");
  }

  it("scores all cases, persists rows, and computes conservative overall score", async () => {
    const { store, registry, runner } = makeRunner(["paris", "Berlin is the capital.", "madrid"]);
    await seed(registry);
    await store.createDataset({
      tenantId: "acme",
      name: "capitals",
      cases: [
        { externalId: "fr", vars: { country: "France" }, expected: { outputText: "Paris" } },
        { externalId: "de", vars: { country: "Germany" }, expected: { contains: "berlin" } },
        { externalId: "es", vars: { country: "Spain" }, expected: { outputText: "Lisbon" } }, // wrong on purpose
      ],
    });

    const input: StartEvalRunInput = {
      tenantId: "acme",
      dataset: { name: "capitals" },
      prompt: { name: "capital-qa", environment: "development" },
      model: "openai/gpt-oss-120b",
      metrics: [{ type: "exact", weight: 1 }, { type: "contains", weight: 1 }],
    };
    const report = await runner.run(input);

    expect(report.status).toBe("completed");
    expect(report.caseCount).toBe(3);
    expect(report.errorCount).toBe(0);
    // exact: paris=1, berlin=0, madrid=0 → mean 1/3
    const exactMean = report.metricMeans.find((entry) => entry.metric === "exact")!.mean;
    expect(exactMean).toBeCloseTo(1 / 3, 6);
    // overall = min across metrics
    expect(report.overallScore).toBeCloseTo(Math.min(...report.metricMeans.map((m) => m.mean)), 6);
    // Rows persisted per case per metric.
    expect(store.resultRows).toHaveLength(report.caseCount * input.metrics.length);
    // Run summary stored.
    const latest = await store.latestRun({ tenantId: "acme", datasetName: "capitals", promptName: "capital-qa" });
    expect(latest?.status).toBe("completed");
  });

  it("counts gateway failures as errored cases instead of crashing", async () => {
    const store = new InMemoryEvalStore();
    const registry = new InMemoryPromptRegistry();
    await seed(registry);
    const gateway: GatewayChatClient = {
      complete: async () => {
        throw new Error("upstream down");
      },
    };
    const runner = new EvalRunner({ evalStore: store, registry, gateway });
    await store.createDataset({
      tenantId: "acme",
      name: "capitals",
      cases: [{ externalId: "fr", vars: { country: "France" }, expected: { outputText: "Paris" } }],
    });

    const report = await runner.run({
      tenantId: "acme",
      dataset: { name: "capitals" },
      prompt: { name: "capital-qa", environment: "development" },
      model: "openai/gpt-oss-120b",
      metrics: [{ type: "exact", weight: 1 }],
    });

    expect(report.status).toBe("failed");
    expect(report.errorCount).toBe(1);
    expect(report.overallScore).toBe(0);
  });
});
