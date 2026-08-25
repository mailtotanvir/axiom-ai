/**
 * OpenTelemetry bootstrap shared by all TypeScript services.
 * Exports OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is configured;
 * otherwise tracing stays inert so local dev and tests stay quiet.
 */

import { type Span, SpanStatusCode, trace, type Tracer, context, type ContextAPI, propagation } from "@opentelemetry/api";

export type { Tracer };
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  otlpEndpoint?: string;
}

export interface TelemetryHandle {
  tracer: Tracer;
  shutdown: () => Promise<void>;
}

const handles = new Map<string, TelemetryHandle>();

export function initTelemetry(options: TelemetryOptions): TelemetryHandle {
  const existing = handles.get(options.serviceName);
  if (existing) {
    return existing;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
  });

  const exporter =
    options.otlpEndpoint !== undefined
      ? new OTLPTraceExporter({ url: `${options.otlpEndpoint.replace(/\/$/, "")}/v1/traces` })
      : undefined;

  const provider = new BasicTracerProvider({ resource });
  if (exporter) {
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  }

  provider.register();
  const tracer = trace.getTracer(options.serviceName, options.serviceVersion);

  const handle: TelemetryHandle = {
    tracer,
    shutdown: async () => {
      await provider.shutdown();
      handles.delete(options.serviceName);
    },
  };
  handles.set(options.serviceName, handle);
  return handle;
}

/** Test/dev helper: logs spans to stdout. Never enable in production. */
export function initConsoleTelemetry(options: TelemetryOptions): TelemetryHandle {
  const provider = new BasicTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
  });
  provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));
  provider.register();
  const tracer = trace.getTracer(options.serviceName, options.serviceVersion);
  return { tracer, shutdown: () => provider.shutdown() };
}

/**
 * Wraps an async operation in a span with error status recording.
 * Keeps services free of manual span boilerplate.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Gen-AI + Axiom semantic-convention attribute names (O1). Every LLM call in
 * every service uses these exact keys so the ops plane can reconstruct a
 * request journey (tokens, cost, cache outcome) from ClickHouse traces.
 */
export const llmAttr = {
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  totalTokens: "gen_ai.usage.total_tokens",
  temperature: "gen_ai.request.temperature",
  maxTokens: "gen_ai.request.max_tokens",
  finishReason: "gen_ai.response.finish_reason",
} as const;

export const axiomAttr = {
  tenantId: "axiom.tenant.id",
  projectId: "axiom.project.id",
  requestId: "axiom.request.id",
  costUsd: "axiom.cost.usd",
  cacheHit: "axiom.cache.hit",
  experimentId: "axiom.experiment.id",
  experimentVariant: "axiom.experiment.variant",
} as const;

export type SpanAttributeValue = string | number | boolean;

export interface LlmCallOutcome {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  responseModel?: string;
  finishReason?: string;
  costUsd?: number;
}

/**
 * Wraps an LLM call in a span carrying Gen-AI attributes; usage/cost
 * recorded on the same span once the call resolves.
 */
export async function withLlmSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, SpanAttributeValue>,
  fn: (span: Span) => Promise<{ value: T; outcome?: LlmCallOutcome }>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const { value, outcome } = await fn(span);
      if (outcome !== undefined) {
        if (outcome.usage?.inputTokens !== undefined) {
          span.setAttribute(llmAttr.inputTokens, outcome.usage.inputTokens);
        }
        if (outcome.usage?.outputTokens !== undefined) {
          span.setAttribute(llmAttr.outputTokens, outcome.usage.outputTokens);
        }
        if (outcome.usage?.totalTokens !== undefined) {
          span.setAttribute(llmAttr.totalTokens, outcome.usage.totalTokens);
        }
        if (outcome.responseModel !== undefined) {
          span.setAttribute(llmAttr.responseModel, outcome.responseModel);
        }
        if (outcome.finishReason !== undefined) {
          span.setAttribute(llmAttr.finishReason, outcome.finishReason);
        }
        if (outcome.costUsd !== undefined) {
          span.setAttribute(axiomAttr.costUsd, outcome.costUsd);
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return value;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Re-exported so services do not take direct OTel API dependencies. */
export const otel = { trace, context, propagation };
export type { ContextAPI };
