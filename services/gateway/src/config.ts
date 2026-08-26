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

const inputCacheOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  ttlSeconds: z.number().int().min(1).max(2_592_000).default(3_600),
  maxEntryBytes: z.number().int().min(1_024).max(8 * 1024 * 1024).default(1_048_576),
});

export const DEFAULT_INPUT_CACHE_OPTIONS = {
  enabled: true,
  ttlSeconds: 3_600,
  maxEntryBytes: 1_048_576,
} as const satisfies z.infer<typeof inputCacheOptionsSchema>;

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
        let jsonValue: unknown;
        try {
          jsonValue = JSON.parse(raw);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: `must be valid JSON (${error instanceof Error ? error.message : "parse error"})`,
          });
          return z.NEVER;
        }
        const parsed = routingConfigSchema.safeParse(jsonValue);
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
    /**
     * Exact-match input cache:
     * {"enabled":true,"ttlSeconds":3600,"maxEntryBytes":1048576}
     */
    GATEWAY_INPUT_CACHE: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === "") {
          return undefined;
        }
        let jsonValue: unknown;
        try {
          jsonValue = JSON.parse(raw);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: `must be valid JSON (${error instanceof Error ? error.message : "parse error"})`,
          });
          return z.NEVER;
        }
        const parsed = inputCacheOptionsSchema.safeParse(jsonValue);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: "custom", message: `GATEWAY_INPUT_CACHE: ${issue.message}` });
          }
          return z.NEVER;
        }
        return parsed.data;
      }),
    /** Anthropic-only: mark the trailing system block with cache_control. */
    GATEWAY_ANTHROPIC_AUTO_SYSTEM_CACHE: z.coerce.boolean().default(false),
    /** Ops control plane serving A/B rules; experiments off when unset. */
    OPS_CONTROL_PLANE_URL: z.string().url().optional(),
    /** How long gateway-cached experiment rules stay fresh. */
    GATEWAY_EXPERIMENTS_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  });

export type GatewayRouting = NonNullable<z.infer<typeof gatewayConfigSchema>["GATEWAY_ROUTING"]>;
export type InputCacheOptionsConfig = NonNullable<
  z.infer<typeof gatewayConfigSchema>["GATEWAY_INPUT_CACHE"]
>;
export type TierLimits = Record<"free" | "pro" | "enterprise", TierLimit>;
export type GatewayConfig = Omit<
  z.infer<typeof gatewayConfigSchema>,
  "GATEWAY_ROUTING" | "GATEWAY_TIER_LIMITS" | "GATEWAY_INPUT_CACHE"
> & {
  GATEWAY_ROUTING: GatewayRouting;
  GATEWAY_TIER_LIMITS: TierLimits;
  GATEWAY_INPUT_CACHE: InputCacheOptionsConfig;
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
    GATEWAY_INPUT_CACHE: parsed.GATEWAY_INPUT_CACHE ?? { ...DEFAULT_INPUT_CACHE_OPTIONS },
  };
}
