/**
 * Chat completions proxy (G1–G7 orchestration):
 *
 *   auth → allowlist → rate limit → guardrails → failover routing →
 *   provider call (SSE passthrough or JSON) → usage metering
 *
 * Streaming responses are forwarded byte-for-byte through a tapping
 * Transform so provider formatting is preserved while usage is extracted;
 * `pipeline()` keeps end-to-end backpressure intact.
 */

import { Readable, Transform, pipeline } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ChatCompletionRequest, TenantContext } from "@axiom-ai/core";
import { AxiomError, errors, otel, withSpan } from "@axiom-ai/core";

import type { GatewayRuntime } from "../runtime.js";
import { resolveTenant } from "../auth/middleware.js";
import { SseTap } from "../providers/sse.js";
import { extractUsageFromSseData } from "../providers/sseUsage.js";
import { extractReportedUsage, resolveUsage } from "../metering/usage.js";

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string(),
        tool_call_id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .min(1)
    .max(256),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
});

interface ReportedUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export function registerChatRoute(app: FastifyInstance, runtime: GatewayRuntime): void {
  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    const record = await resolveTenant(runtime.keyStore, request);
    const tenant: TenantContext = {
      tenantId: record.tenantId,
      projectId: record.projectId,
      allowedModels: record.allowedModels,
      rateLimitTier: record.rateLimitTier,
    };

    // --------------------------- Validation ---------------------------
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.validationFailed(parsed.error.flatten());
    }
    const wire = parsed.data;
    const unified: ChatCompletionRequest = toUnified(wire, request.id);

    if (
      tenant.allowedModels.length > 0 &&
      !tenant.allowedModels.includes(unified.model)
    ) {
      throw errors.modelNotAllowed(unified.model);
    }

    // -------------------------- Rate limits ---------------------------
    const decision = await runtime.limiter.consume(tenant);
    void reply.header("x-ratelimit-limit", String(decision.limit));
    void reply.header("x-ratelimit-remaining", String(decision.remaining));
    void reply.header("x-ratelimit-reset", String(decision.resetAtSeconds));
    if (!decision.allowed) {
      const retryAfter = Math.max(1, decision.resetAtSeconds - Math.floor(Date.now() / 1000));
      void reply.header("retry-after", String(retryAfter));
      throw errors.rateLimited(retryAfter);
    }

    // --------------------------- Guardrails ---------------------------
    const verdict = await runtime.guardrails.onRequest(
      { tenantId: tenant.tenantId, projectId: tenant.projectId, requestId: request.id },
      unified,
    );
    if (verdict.action === "block") {
      throw new AxiomError(
        "AXIOM_VALIDATION_FAILED",
        `Blocked by guardrail: ${verdict.reason}`,
      );
    }
    const effectiveRequest = verdict.action === "redact" ? verdict.request : unified;

    // ---------------------------- Routing -----------------------------
    const catalogEntry = runtime.registry.get(effectiveRequest.model);
    const candidates = runtime.router.resolve(effectiveRequest.model, catalogEntry?.provider);
    if (candidates.length === 0) {
      throw errors.modelNotAllowed(effectiveRequest.model);
    }

    // Abort the upstream when the client disconnects mid-flight.
    const clientAbort = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        clientAbort.abort();
      }
    });

    // W3C trace-context propagation to the upstream.
    const traceHeaders: Record<string, string> = {};
    otel.propagation.inject(otel.context.active(), traceHeaders);

    // ------------------------- Failover loop --------------------------
    let lastFailure:
      | { reason: string; status?: number; message?: string; provider: string }
      | undefined;

    for (const adapter of candidates) {
      if (!runtime.breaker.canAttempt(adapter.id)) {
        continue;
      }
      const attemptStart = Date.now();
      const result = await withSpan(app.telemetry.tracer, `gateway.upstream.${adapter.id}`, {}, async () =>
        effectiveRequest.stream === true
          ? adapter.stream({ body: effectiveRequest, signal: clientAbort.signal, headers: traceHeaders })
          : adapter.complete({ body: effectiveRequest, signal: clientAbort.signal, headers: traceHeaders }),
      );

      if (!result.ok) {
        runtime.breaker.recordFailure(adapter.id);
        lastFailure = {
          reason: result.reason,
          status: result.status,
          message: result.message,
          provider: adapter.id,
        };
        continue;
      }
      runtime.breaker.recordSuccess(adapter.id);

      void reply.header("x-axiom-provider", adapter.id);
      void reply.header("x-axiom-model", effectiveRequest.model);

      if (effectiveRequest.stream === true && result.stream !== undefined) {
        await pipeStreamingResponse(reply, result.stream, {
          onFinish: async (state) => {
            await emitMeterRecord(runtime, {
              requestId: request.id,
              tenant,
              request: effectiveRequest,
              completionText: state.completionText,
              reported: state.reported,
              provider: adapter.id,
              streamed: true,
              latencyMs: Date.now() - attemptStart,
              upstreamStatus: result.status,
            });
          },
        });
        return reply;
      }

      // Non-streaming: forward native wire body verbatim.
      await emitMeterRecord(runtime, {
        requestId: request.id,
        tenant,
        request: effectiveRequest,
        completionText: readCompletionText(result.json),
        reported: extractReportedUsage(result.json),
        provider: adapter.id,
        streamed: false,
        latencyMs: Date.now() - attemptStart,
        upstreamStatus: result.status,
      });
      return reply.status(result.status).send(result.json);
    }

    if (lastFailure?.status === 429) {
      throw errors.upstreamUnavailable(lastFailure.provider);
    }
    throw errors.allUpstreamsFailed(candidates.map((candidate) => candidate.id));
  });
}

/* -------------------------------- helpers -------------------------------- */

function toUnified(
  wire: z.infer<typeof chatRequestSchema>,
  requestId: string,
): ChatCompletionRequest {
  return {
    model: wire.model,
    messages: wire.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id !== undefined ? { toolCallId: m.tool_call_id } : {}),
      ...(m.name !== undefined ? { name: m.name } : {}),
    })),
    temperature: wire.temperature,
    topP: wire.top_p,
    maxTokens: wire.max_tokens,
    stopSequences:
      Array.isArray(wire.stop) ? wire.stop : wire.stop !== undefined ? [wire.stop] : undefined,
    stream: wire.stream ?? false,
    requestId,
  };
}

function readCompletionText(json: unknown): string {
  const choices = (json as { choices?: Array<{ message?: { content?: string } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

async function emitMeterRecord(
  runtime: GatewayRuntime,
  input: {
    requestId: string;
    tenant: TenantContext;
    request: ChatCompletionRequest;
    completionText: string;
    reported: ReportedUsage | undefined;
    provider: string;
    streamed: boolean;
    latencyMs: number;
    upstreamStatus: number;
  },
): Promise<void> {
  const outcome = resolveUsage(input.request, input.completionText, input.reported);
  const entry = runtime.registry.get(input.request.model);
  const costUsd =
    (outcome.promptTokens / 1_000_000) * (entry?.inputCostPerMillion ?? 0) +
    (outcome.completionTokens / 1_000_000) * (entry?.outputCostPerMillion ?? 0);

  for (const sink of runtime.sinks) {
    await sink.record({
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      tenantId: input.tenant.tenantId,
      projectId: input.tenant.projectId,
      model: input.request.model,
      provider: input.provider,
      streamed: input.streamed,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      totalTokens: outcome.totalTokens,
      usageSource: outcome.source,
      reconciliationDelta: outcome.reconciliationDelta,
      costUsd,
      latencyMs: input.latencyMs,
      upstreamStatus: input.upstreamStatus,
    });
  }
}

interface TapState {
  completionText: string;
  reported: ReportedUsage | undefined;
}

/**
 * Streams the upstream SSE body to the client byte-for-byte with full
 * backpressure, extracting delta text + reported usage along the way.
 */
async function pipeStreamingResponse(
  reply: FastifyReply,
  upstream: ReadableStream<Uint8Array>,
  hooks: {
    onFinish: (state: TapState) => Promise<void>;
  },
): Promise<void> {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const state: TapState = { completionText: "", reported: undefined };
  const tap = new SseTap((event) => {
    try {
      const parsed = JSON.parse(event.data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const deltaContent = parsed.choices?.[0]?.delta?.content;
      if (typeof deltaContent === "string") {
        state.completionText += deltaContent;
      }
    } catch {
      // Non-JSON frames are forwarded untouched.
    }
    const usage = extractUsageFromSseData(event.data);
    if (usage !== null) {
      state.reported = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      };
    }
  });

  const tapping = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        callback(null, tap.push(new Uint8Array(chunk)));
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      tap.finish();
      callback();
    },
  });

  try {
    await pipeline(Readable.fromWeb(upstream), tapping, reply.raw);
    await hooks.onFinish(state);
  } catch {
    // Client disconnect or upstream reset: socket cleanup already handled.
  }
}
