/**
 * Centralized environment configuration contract (spec section 5).
 * Every service extends `baseConfigSchema` and loads config exclusively
 * through `loadConfig`, which fails fast on missing or invalid values.
 */

import { z } from "zod";

/** Treats "" / whitespace-only env values as unset so blank .env entries are safe. */
function blankToUndefined<S extends z.ZodTypeAny>(schema: S): z.ZodEffects<S> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema,
  );
}

/** Optional string that also accepts "" (common in checked-in .env templates). */
const optionalSecret = blankToUndefined(z.string().min(1).optional());

const url = blankToUndefined(z.string().url());
const optionalUrl = url.optional();

export const AXIOM_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

export const baseConfigSchema = z.object({
  AXIOM_ENV: z.enum(AXIOM_ENVIRONMENTS).default("development"),
  /** Required with >= 32 chars in production; relaxed elsewhere for local dev. */
  AXIOM_INTER_SERVICE_SECRET: z.string().default("dev-only-inter-service-secret"),

  REDIS_PRIMARY_URL: optionalUrl,
  POSTGRES_DB_URI: optionalUrl,
  CLICKHOUSE_NODES: z
    .string()
    .transform((value) => value.split(",").map((node) => node.trim()).filter(Boolean))
    .optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
});

export const providerKeysSchema = z.object({
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  GROQ_API_KEY: optionalSecret,
  MISTRAL_API_KEY: optionalSecret,
  SILICONFLOW_API_KEY: optionalSecret,
  NVIDIA_NIM_API_KEY: optionalSecret,
});

export const serviceEndpointsSchema = z.object({
  GATEWAY_INTERNAL_URL: url.default("http://localhost:3000"),
  RAG_PIPELINE_INTERNAL_URL: url.default("http://localhost:8000"),
  AGENT_RUNTIME_INTERNAL_URL: url.default("http://localhost:5000"),
  OBSERVABILITY_INTERNAL_URL: url.default("http://localhost:4000"),
});

export type AxiomBaseConfig = z.infer<typeof baseConfigSchema>;
export type ProviderKeys = z.infer<typeof providerKeysSchema>;
export type ServiceEndpoints = z.infer<typeof serviceEndpointsSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid Axiom configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

/**
 * Parses and validates configuration, enforcing production-grade invariants.
 * Services should compose schemas: `baseConfigSchema.merge(myServiceSchema)`.
 */
export function loadConfig<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): z.infer<z.ZodObject<T>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }

  const config = result.data;
  if (
    config.AXIOM_ENV === "production" &&
    (!env.AXIOM_INTER_SERVICE_SECRET || env.AXIOM_INTER_SERVICE_SECRET.length < 32)
  ) {
    throw new ConfigurationError([
      {
        path: "AXIOM_INTER_SERVICE_SECRET",
        message: "must be set to at least 32 characters in production",
      },
    ]);
  }

  return config;
}
