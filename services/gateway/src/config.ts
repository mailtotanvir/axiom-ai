import { z } from "zod";

import {
  baseConfigSchema,
  loadConfig,
  providerKeysSchema,
  serviceEndpointsSchema,
} from "@axiom-ai/core";

export const gatewayConfigSchema = baseConfigSchema
  .merge(providerKeysSchema)
  .merge(serviceEndpointsSchema)
  .extend({
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    GATEWAY_HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  });

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function createGatewayConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GatewayConfig {
  return loadConfig(gatewayConfigSchema, env);
}
