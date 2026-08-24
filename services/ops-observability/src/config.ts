import { z } from "zod";

import { baseConfigSchema, loadConfig, serviceEndpointsSchema } from "@axiom-ai/core";

export const opsConfigSchema = baseConfigSchema
  .merge(serviceEndpointsSchema)
  .extend({
    OBSERVABILITY_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    OBSERVABILITY_HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  });

export type OpsConfig = z.infer<typeof opsConfigSchema>;

export function createOpsConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): OpsConfig {
  return loadConfig(opsConfigSchema, env);
}
