import { z } from "zod";

import { baseConfigSchema, loadConfig, serviceEndpointsSchema } from "@axiom-ai/core";

export const agentRuntimeConfigSchema = baseConfigSchema
  .merge(serviceEndpointsSchema)
  .extend({
    AGENT_RUNTIME_PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    AGENT_RUNTIME_HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** Gateway API key used for planner calls (issued via the gateway admin API). */
    AGENT_RUNTIME_LLM_API_KEY: z.string().optional(),
    /** Postgres for the durable run-event log; in-memory when unset (dev/tests). */
    AGENT_RUNTIME_PG_URI: z.string().optional(),
  });

export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

export function createAgentRuntimeConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AgentRuntimeConfig {
  return loadConfig(agentRuntimeConfigSchema, env);
}
