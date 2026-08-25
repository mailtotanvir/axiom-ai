/**
 * Prompt registry contracts (O2). Zod validates every request body;
 * semver and environment values are constrained here so stores and
 * routes stay dumb.
 */

import { z } from "zod";

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Promotion must walk dev → staging → production in order. */
export const ENVIRONMENT_ORDER: Record<Environment, number> = {
  development: 0,
  staging: 1,
  production: 2,
};

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  return (
    aMajor! - bMajor! || aMinor! - bMinor! || aPatch! - bPatch!
  );
}

export const createPromptSchema = z.object({
  tenantId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_.]*$/i, "must be alphanumeric with - _ . separators"),
  description: z.string().optional(),
});

export const createVersionSchema = z.object({
  semver: z.string().regex(SEMVER_PATTERN, "must be MAJOR.MINOR.PATCH"),
  template: z.string().min(1),
  /** JSON Schema (draft-07) for template variables. */
  templateSchema: z.record(z.unknown()).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const promoteSchema = z.object({
  environment: z.enum(ENVIRONMENTS),
  promotedBy: z.string().optional(),
});

export const renderSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1),
  vars: z.record(z.unknown()).default({}),
  environment: z.enum(ENVIRONMENTS).default("development"),
});

export interface PromptDto {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  createdAt: string;
}

export interface VersionDto {
  id: string;
  promptId: string;
  semver: string;
  template: string;
  templateSchema?: Record<string, unknown> | null;
  model?: string | null;
  temperature?: number | null;
  status: "draft" | "published" | "archived";
  createdAt: string;
  publishedAt?: string | null;
  environments: Environment[];
}

export type PromptRegistryStore = {
  createPrompt(input: {
    tenantId: string;
    name: string;
    description?: string;
  }): Promise<PromptDto>;
  getPrompt(tenantId: string, name: string): Promise<PromptDto | null>;
  listPrompts(tenantId: string): Promise<PromptDto[]>;

  createVersion(
    tenantId: string,
    name: string,
    input: {
      semver: string;
      template: string;
      templateSchema?: Record<string, unknown>;
      model?: string;
      temperature?: number;
    },
  ): Promise<VersionDto>;
  listVersions(tenantId: string, name: string): Promise<VersionDto[]>;
  getVersion(tenantId: string, name: string, semver: string): Promise<VersionDto | null>;
  publish(tenantId: string, name: string, semver: string): Promise<VersionDto>;
  archive(tenantId: string, name: string, semver: string): Promise<VersionDto>;
  promote(
    tenantId: string,
    name: string,
    semver: string,
    environment: Environment,
    promotedBy?: string,
  ): Promise<VersionDto>;
};
