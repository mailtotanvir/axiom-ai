import { z } from "zod";

import {
  baseConfigSchema,
  loadConfig,
  providerKeysSchema,
  serviceEndpointsSchema,
} from "@axiom-ai/core";

import { tierLimitsSchema, DEFAULT_TIER_LIMITS, type TierLimit } from "./ratelimit/tierLimits.js";

const providerIdSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "mistral",
  "siliconflow",
  "nvidia-nim",
]);

const routingConfigSchema = z.object({
  defaultChain: z.array(providerIdSchema).default(["gemini", "groq", "mistral"]),
  overrides: z.record(z.string(), z.array(providerIdSchema)).optional(),
});

export const gatewayConfigSchema = baseConfigSchema
  .merge(providerKeysSchema)
  .merge(serviceEndpointsSchema)
  .extend({
    GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    GATEWAY_HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** Per-upstream request timeout in milliseconds. */
    GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
    /** JSON: {"defaultChain":[...],"overrides":{"model":["...",...]}} */
    GATEWAY_ROUTING: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === "") {
          return undefined;
        }
        const parsed = routingConfigSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: "custom", message: `GATEWAY_ROUTING: ${issue.message}` });
          }
          return z.NEVER;
        }
        return parsed.data;
      }),
    GATEWAY_TIER_LIMITS: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === "") {
          return undefined;
        }
        const parsed = tierLimitsSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: "custom", message: `GATEWAY_TIER_LIMITS: ${issue.message}` });
          }
          return z.NEVER;
        }
        return parsed.data;
      }),
    /** Circuit breaker tuning. */
    GATEWAY_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),
    GATEWAY_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(100).default(10_000),
  });

export type GatewayRouting = NonNullable<z.infer<typeof gatewayConfigSchema>["GATEWAY_ROUTING"]>;
export type TierLimits = Record<"free" | "pro" | "enterprise", TierLimit>;
export type GatewayConfig = Omit<
  z.infer<typeof gatewayConfigSchema>,
  "GATEWAY_ROUTING" | "GATEWAY_TIER_LIMITS"
> & {
  GATEWAY_ROUTING: GatewayRouting;
  GATEWAY_TIER_LIMITS: TierLimits;
};

export function createGatewayConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GatewayConfig {
  const parsed = loadConfig(gatewayConfigSchema, env);
  const tierLimits = (parsed.GATEWAY_TIER_LIMITS ?? DEFAULT_TIER_LIMITS) as TierLimits;
  return {
    ...parsed,
    GATEWAY_ROUTING: parsed.GATEWAY_ROUTING ?? { defaultChain: ["gemini", "groq", "mistral"] },
    GATEWAY_TIER_LIMITS: tierLimits,
  };
}
