/**
 * Eval engine contracts (O3). Datasets are versioned and tenant-scoped;
 * a run scores a prompt-version × model combination against every case
 * with one or more metrics.
 */

import { z } from "zod";

export const METRIC_TYPES = [
  "exact",
  "contains",
  "regex",
  "json_path_equals",
  "llm_judge",
] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const metricSchema = z.object({
  type: z.enum(METRIC_TYPES),
  /** Weight for overall aggregation; defaults to 1. */
  weight: z.number().positive().default(1),
});
export type Metric = z.infer<typeof metricSchema>;

/** Expectations read from each golden case's `expected` JSON blob. */
export interface CaseExpectation {
  outputText?: string;
  contains?: string;
  pattern?: string;
  jsonPath?: string;
  jsonValue?: unknown;
  /** Natural-language criterion for llm_judge. */
  criterion?: string;
}

export const createDatasetSchema = z.object({
  tenantId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_.]*$/i, "must be alphanumeric with - _ . separators"),
  cases: z
    .array(
      z.object({
        externalId: z.string().min(1),
        vars: z.record(z.unknown()),
        expected: z.record(z.unknown()),
      }),
    )
    .min(1),
});

export type CreateDatasetInput = z.infer<typeof createDatasetSchema>;

export const startEvalRunSchema = z.object({
  tenantId: z.string().min(1),
  dataset: z.object({ name: z.string().min(1), version: z.number().int().optional() }),
  prompt: z.object({
    name: z.string().min(1),
    semver: z.string().optional(),
    environment: z.enum(["development", "staging", "production"]).default("development"),
  }),
  model: z.string().min(1),
  metrics: z.array(metricSchema).min(1).max(10),
  maxCases: z.number().int().positive().max(500).optional(),
});

export type StartEvalRunInput = z.infer<typeof startEvalRunSchema>;

export interface MetricOutcome {
  score: number; // 0..1
  passed: boolean;
  detail?: string;
}

export interface CaseResult {
  caseId: string;
  outputs: Record<MetricType, MetricOutcome>;
  error?: string;
}

export interface EvalReport {
  runId: string;
  tenantId: string;
  datasetName: string;
  datasetVersion: number;
  promptName: string;
  promptVersion: string;
  model: string;
  status: "completed" | "failed";
  caseCount: number;
  errorCount: number;
  /** Weighted mean of per-metric means; conservative min across metrics. */
  overallScore: number;
  metricMeans: Array<{ metric: MetricType; mean: number }>;
  cases: CaseResult[];
}
