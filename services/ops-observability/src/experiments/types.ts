/**
 * A/B experimentation contracts (O4). Experiments are tenant-scoped traffic
 * splits whose arms reference prompt versions and/or model overrides; the
 * gateway resolves assignments deterministically from the rules this plane
 * serves.
 */

import { z } from "zod";

export const EXPERIMENT_STATUSES = ["draft", "running", "completed", "archived"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const armSpecSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, "must be alphanumeric with - _ separators"),
    /** Integer percentage of traffic; all arms must sum to 100. */
    weight: z.number().int().min(0).max(100),
    model: z.string().min(1).optional(),
    prompt: z
      .object({
        name: z.string().min(1),
        semver: z.string().optional(),
      })
      .optional(),
  })
  .refine((arm) => arm.model !== undefined || arm.prompt !== undefined, {
    message: "each arm must reference a model or a prompt version",
    path: ["model"],
  });

export type ArmSpec = z.infer<typeof armSpecSchema>;

export const createExperimentSchema = z
  .object({
    tenantId: z.string().min(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_.]*$/i, "must be alphanumeric with - _ . separators"),
    /** Optional narrowing: only requests for these models participate. */
    targetingModels: z.array(z.string().min(1)).min(1).optional(),
    arms: z.array(armSpecSchema).min(2).max(8),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const [index, arm] of value.arms.entries()) {
      if (names.has(arm.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate arm name '${arm.name}'`,
          path: ["arms", index, "name"],
        });
      }
      names.add(arm.name);
    }
    const total = value.arms.reduce((sum, arm) => sum + arm.weight, 0);
    if (total !== 100) {
      ctx.addIssue({
        code: "custom",
        message: `arm weights must sum to 100 (got ${total})`,
        path: ["arms"],
      });
    }
  });

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

export const assignmentSchema = z.object({
  arm: z.string().min(1),
  /** sha256 hex of the sticky bucketing key — raw ids never leave the gateway. */
  keyHash: z.string().regex(/^[a-f0-9]{8,64}$/),
  requestId: z.string().min(1).max(256).optional(),
});

export const outcomeSchema = z.object({
  keyHash: z.string().regex(/^[a-f0-9]{8,64}$/),
  value: z.number().finite(),
});

export interface ExperimentArmDto {
  name: string;
  weight: number;
  model?: string;
  prompt?: { name: string; semver?: string };
}

export interface ExperimentDto {
  id: string;
  tenantId: string;
  name: string;
  status: ExperimentStatus;
  targetingModels?: string[];
  arms: ExperimentArmDto[];
  createdAt: string;
}

/** Wire shape the gateway consumes (GET /v1/rules/experiments). */
export interface ExperimentRule {
  experimentId: string;
  tenantId: string;
  name: string;
  salt: string;
  /** Only requests for these models participate; absent = all models. */
  targetingModels?: string[];
  arms: Array<{
    name: string;
    weight: number;
    model?: string;
    template?: string;
  }>;
}

export interface RulesResponse {
  rules: ExperimentRule[];
  unresolved: Array<{ experimentId: string; arm: string; reason: string }>;
}

export interface AssignmentEvent {
  experimentId: string;
  arm: string;
  keyHash: string;
  requestId?: string;
}

export interface OutcomeEvent {
  experimentId: string;
  keyHash: string;
  value: number;
}
