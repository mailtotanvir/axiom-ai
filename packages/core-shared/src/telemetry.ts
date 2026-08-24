/**
 * OpenTelemetry bootstrap shared by all TypeScript services.
 * Exports OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is configured;
 * otherwise tracing stays inert so local dev and tests stay quiet.
 */

import { type Span, SpanStatusCode, trace, type Tracer, context, type ContextAPI } from "@opentelemetry/api";
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

/** Re-exported so services do not take direct OTel API dependencies. */
export const otel = { trace, context };
export type { ContextAPI };
