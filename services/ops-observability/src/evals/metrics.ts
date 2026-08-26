/**
 * Metric registry (O3). Deterministic scorers run in-process; llm_judge
 * asks a model through the gateway to score free-form criteria.
 */

import type { CaseExpectation, MetricOutcome, MetricType } from "./types.js";

export interface ScoreInput {
  output: string;
  expectation: CaseExpectation;
  /** Only used by llm_judge. */
  judge?: (criterion: string, output: string) => Promise<number>;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function scoreOne(type: MetricType, input: ScoreInput): Promise<MetricOutcome> {
  const { output, expectation } = input;
  switch (type) {
    case "exact": {
      const expected = expectation.outputText ?? "";
      return {
        score: normalize(output) === normalize(expected) ? 1 : 0,
        passed: normalize(output) === normalize(expected),
        detail: expected === "" ? undefined : `expected ${JSON.stringify(expected).slice(0, 120)}`,
      };
    }
    case "contains": {
      const needle = expectation.contains ?? "";
      const hit = needle !== "" && normalize(output).includes(normalize(needle));
      return { score: hit ? 1 : 0, passed: hit, detail: `needle ${JSON.stringify(needle).slice(0, 80)}` };
    }
    case "regex": {
      let hit: boolean;
      try {
        hit = new RegExp(expectation.pattern ?? "").test(output);
      } catch {
        return { score: 0, passed: false, detail: "invalid pattern" };
      }
      return { score: hit ? 1 : 0, passed: hit, detail: `pattern /${expectation.pattern}/` };
    }
    case "json_path_equals": {
      try {
        const parsed: unknown = JSON.parse(output);
        const actual = readPath(parsed, expectation.jsonPath ?? "");
        const equal = JSON.stringify(actual) === JSON.stringify(expectation.jsonValue);
        return { score: equal ? 1 : 0, passed: equal };
      } catch {
        return { score: 0, passed: false, detail: "output is not valid JSON" };
      }
    }
    case "llm_judge": {
      if (input.judge === undefined) {
        return { score: 0, passed: false, detail: "no judge configured" };
      }
      try {
        const raw = await input.judge(expectation.criterion ?? "", output);
        const clamped = Math.max(0, Math.min(1, raw));
        // Threshold: a judge score of at least 0.7 counts as passing.
        return { score: clamped, passed: clamped >= 0.7 };
      } catch (error) {
        return {
          score: 0,
          passed: false,
          detail: `judge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
}

/** Scores one case across the requested metric types; every metric runs. */
export async function scoreCase(
  types: readonly MetricType[],
  input: ScoreInput,
): Promise<Record<MetricType, MetricOutcome>> {
  const outcomes: Partial<Record<MetricType, MetricOutcome>> = {};
  for (const type of new Set(types)) {
    outcomes[type] = await scoreOne(type, input);
  }
  return outcomes as Record<MetricType, MetricOutcome>;
}
