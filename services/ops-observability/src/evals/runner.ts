/**
 * Eval runner (O3). For every golden case: render the prompt version's
 * template with the case vars, call the model through the gateway, score
 * with the requested metrics, and persist per-metric rows to ClickHouse.
 */

import { renderTemplate } from "../prompts/render.js";
import type { PromptRegistryStore } from "../prompts/types.js";
import type { ClickHouseClient } from "../clickhouse.js";
import { scoreCase } from "./metrics.js";
import type { EvalResultRow, EvalStore } from "./store.js";
import {
  type CaseExpectation,
  type CaseResult,
  type EvalReport,
  type StartEvalRunInput,
} from "./types.js";

/** Minimal gateway chat client; injectable for tests. */
export interface GatewayChatClient {
  complete(model: string, messages: Array<{ role: string; content: string }>): Promise<string>;
}

export class HttpGatewayChatClient implements GatewayChatClient {
  constructor(
    private readonly gatewayUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const response = await this.fetchImpl(
      `${this.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0 }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      throw new Error(`gateway returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content ?? "";
  }
}

/** Per-case metric row sink (ClickHouse in prod, no-op in tests). */
export interface EvalResultsSink {
  insert(rows: EvalResultRow[]): Promise<void>;
}

export class ClickHouseEvalResultsSink implements EvalResultsSink {
  constructor(private readonly clickhouse: ClickHouseClient) {}

  async insert(rows: EvalResultRow[]): Promise<void> {
    // Column names are snake_case per the ClickHouse schema convention.
    const body = rows
      .map((row) =>
        JSON.stringify({
          timestamp: row.timestamp,
          run_id: row.runId,
          tenant_id: row.tenantId,
          dataset_name: row.datasetName,
          dataset_version: row.datasetVersion,
          prompt_name: row.promptName,
          prompt_version: row.promptVersion,
          model: row.model,
          case_id: row.caseId,
          metric: row.metric,
          score: row.score,
          passed: row.passed ? 1 : 0,
          detail: (row.detail ?? "").slice(0, 1024),
        }),
      )
      .join("\n");
    await this.clickhouse.insert("INSERT INTO axiom.eval_results FORMAT JSONEachRow", body);
  }
}

export interface RunnerDeps {
  evalStore: EvalStore;
  registry: PromptRegistryStore;
  resultsSink?: EvalResultsSink;
  gateway: GatewayChatClient;
}

export class EvalRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(input: StartEvalRunInput): Promise<EvalReport> {
    const dataset = await this.deps.evalStore.getDataset(
      input.tenantId,
      input.dataset.name,
      input.dataset.version,
    );
    if (dataset === null) {
      throw new DatasetNotFound(input.dataset.name);
    }

    const versions = await this.deps.registry.listVersions(input.tenantId, input.prompt.name);
    const resolved =
      input.prompt.semver !== undefined
        ? versions.find((version) => version.semver === input.prompt.semver)
        : versions.find(
            (version) =>
              version.status === "published" &&
              version.environments.includes(input.prompt.environment),
          );
    if (resolved === undefined) {
      throw new PromptVersionNotFound(input.prompt.name);
    }
    if (resolved.status !== "published") {
      throw new PromptNotPublished(input.prompt.name, resolved.semver);
    }

    const cases = input.maxCases !== undefined ? dataset.cases.slice(0, input.maxCases) : dataset.cases;
    const runId = await this.deps.evalStore.startRun({
      tenantId: input.tenantId,
      datasetName: input.dataset.name,
      datasetVersion: dataset.version,
      promptName: input.prompt.name,
      promptVersion: resolved.semver,
      model: input.model,
    });

    const metricTypes = input.metrics.map((metric) => metric.type);

    const results: CaseResult[] = [];
    const rows: EvalResultRow[] = [];
    let errorCount = 0;

    for (const testCase of cases) {
      try {
        const rendered = renderTemplate(
          `${input.tenantId}/${input.prompt.name}@${resolved.semver}`,
          resolved.template,
          testCase.vars,
          resolved.templateSchema ?? null,
        );
        if (!rendered.ok) {
          throw new Error(`template render failed: ${JSON.stringify(rendered.errors)}`);
        }
        const output = await this.deps.gateway.complete(input.model, [
          { role: "user", content: rendered.rendered ?? "" },
        ]);
        const expectation = testCase.expected as CaseExpectation;
        const judge =
          metricTypes.includes("llm_judge")
            ? async (criterion: string, judgeOutput: string): Promise<number> => {
                const verdict = await this.deps.gateway.complete(input.model, [
                  {
                    role: "system",
                    content:
                      "You are a strict evaluator. Answer with a single number between 0 and 1.",
                  },
                  {
                    role: "user",
                    content: `Criterion: ${criterion}\n\nOutput: ${judgeOutput}\n\nScore:`,
                  },
                ]);
                return Number.parseFloat(verdict.trim());
              }
            : undefined;
        const outcomes = await scoreCase(metricTypes, { output, expectation, judge });
        results.push({ caseId: testCase.externalId, outputs: outcomes });
        const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
        for (const [metric, outcome] of Object.entries(outcomes)) {
          rows.push({
            timestamp,
            runId,
            tenantId: input.tenantId,
            datasetName: input.dataset.name,
            datasetVersion: dataset.version,
            promptName: input.prompt.name,
            promptVersion: resolved.semver,
            model: input.model,
            caseId: testCase.externalId,
            metric,
            score: outcome.score,
            passed: outcome.passed,
            detail: outcome.detail ?? "",
          });
        }
      } catch (error) {
        errorCount += 1;
        results.push({
          caseId: testCase.externalId,
          outputs: {} as CaseResult["outputs"],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Per-metric means; overall is the conservative min across metrics so a
    // single weak metric cannot hide behind strong ones.
    const metricMeans = metricTypes.map((type) => {
      const scores = results
        .filter((result) => result.outputs[type] !== undefined)
        .map((result) => result.outputs[type]!.score);
      const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      return { metric: type, mean };
    });
    const overallScore =
      metricMeans.length > 0 ? Math.min(...metricMeans.map((entry) => entry.mean)) : 0;

    const report: EvalReport = {
      runId,
      tenantId: input.tenantId,
      datasetName: input.dataset.name,
      datasetVersion: dataset.version,
      promptName: input.prompt.name,
      promptVersion: resolved.semver,
      model: input.model,
      status: errorCount >= cases.length && cases.length > 0 ? "failed" : "completed",
      caseCount: cases.length,
      errorCount,
      overallScore,
      metricMeans,
      cases: results,
    };

    await this.deps.evalStore.finishRun(runId, report);
    if (rows.length > 0) {
      await this.deps.evalStore.writeResults(rows);
      if (this.deps.resultsSink !== undefined) {
        await this.deps.resultsSink.insert(rows);
      }
    }
    return report;
  }
}

export class DatasetNotFound extends Error {
  constructor(name: string) {
    super(`golden dataset '${name}' not found`);
    this.name = "DatasetNotFound";
  }
}

export class PromptVersionNotFound extends Error {
  constructor(name: string) {
    super(`no resolvable published version for prompt '${name}'`);
    this.name = "PromptVersionNotFound";
  }
}

export class PromptNotPublished extends Error {
  constructor(name: string, semver: string) {
    super(`prompt '${name}' ${semver} is not published`);
    this.name = "PromptNotPublished";
  }
}
