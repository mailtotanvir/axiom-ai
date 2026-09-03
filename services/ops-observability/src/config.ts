import { z } from "zod";

import { baseConfigSchema, loadConfig, serviceEndpointsSchema } from "@tanvir1971/core";

export const opsConfigSchema = baseConfigSchema
  .merge(serviceEndpointsSchema)
  .extend({
    OBSERVABILITY_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    OBSERVABILITY_HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** Global baseline; per-tenant policies narrow this further at query time. */
    TRACE_RETENTION_DEFAULT_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /** Milestone 5.4: billing stays off unless explicitly enabled (test keys only). */
    AXIOM_BILLING_ENABLED: z.enum(["true", "false"]).default("false"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_TENANT_SUBSCRIPTION_ITEMS: z.string().optional(),
  });

export type OpsConfig = z.infer<typeof opsConfigSchema>;

export function createOpsConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): OpsConfig {
  return loadConfig(opsConfigSchema, env);
}
