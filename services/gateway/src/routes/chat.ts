/**
 * Chat completions proxy (G1–G7 orchestration + input cache):
 *
 *   auth → allowlist → rate limit → guardrails → input-cache lookup →
 *   failover routing → provider call (SSE passthrough or JSON) →
 *   usage metering → cache store
 *
 * Input caching: identical requests (same tenant, model, messages, and
 * sampling parameters) are served from a stored response — byte-identical
 * for streaming replays — without an upstream call. Concurrent identical
 * non-streaming misses collapse into one in-flight upstream call.
 */

import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ProviderAdapter, UpstreamResult } from "../providers/types.js";
import type { ChatCompletionRequest, TenantContext } from "@axiom-ai/core";
import {
  AxiomError,
  axiomAttr,
  errors,
  llmAttr,
  otel,
  withLlmSpan,
  type LlmCallOutcome,
} from "@axiom-ai/core";

import type { GatewayRuntime } from "../runtime.js";
import { resolveTenant } from "../auth/middleware.js";
import { SseTap } from "../providers/sse.js";
import { extractUsageFromSseData } from "../providers/sseUsage.js";
import type { CacheEnvelope } from "../cache/inputCache.js";
import {
  computeCostUsd,
  extractReportedUsage,
  resolveUsage,
  type ReportedUsage,
} from "../metering/usage.js";

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string(),
        tool_call_id: z.string().optional(),
        name: z.string().optional(),
        /** Anthropic-style prompt-cache marker. */
        cache_control: z.enum(["ephemeral"]).optional(),
      }),
    )
    .min(1)
    .max(256),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        parameters_json_schema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(128)
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  /** OpenAI prompt-cache routing hint. */
  prompt_cache_key: z.string().min(1).max(256).optional(),
});

/** Outcome of one successful upstream pass (non-streaming). */
interface NonStreamingOutcome {
  status: number;
  jsonText: string;
  provider: string;
  completionText: string;
  reported: ReportedUsage | undefined;
  latencyMs: number;
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

    // Tool-calling requests are excluded from the exact-match cache by
    // default: tool results are frequently nondeterministic or time-bound.
    const cacheable =
      runtime.inputCache.options.enabled && effectiveRequest.tools === undefined;
    const cacheKey = cacheable
      ? runtime.inputCache.keyFor(tenant.tenantId, effectiveRequest)
      : null;

    // Abort the upstream when the client disconnects mid-flight.
    const clientAbort = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded && !reply.raw.writableFinished) {
        clientAbort.abort();
      }
    });

    // W3C trace-context propagation to the upstream.
    const traceHeaders: Record<string, string> = {};
    otel.propagation.inject(otel.context.active(), traceHeaders);

    /* -------------------- Cache lookup (both modes) -------------------- */
    if (cacheKey !== null) {
      const hit = await runtime.inputCache.lookup(cacheKey);
      if (hit !== undefined) {
        await emitMeterRecord(runtime, buildMeterInput(request.id, tenant, effectiveRequest, hit));
        deliverCached(reply, hit, "HIT");
        return;
      }
    }

    /* --------------------------- Streaming ---------------------------- */
    if (effectiveRequest.stream === true) {
      await streamViaFailover(app, runtime, request, reply, {
        tenant,
        effectiveRequest,
        candidates: resolveCandidates(runtime, effectiveRequest),
        clientAbort,
        traceHeaders,
        cacheKey,
        requestId: request.id,
      });
      return;
    }

    /* -------------------- Non-streaming + dedupe ---------------------- */
    const outcome = await runtime.inputCache.dedupe(
      `sf:${cacheKey ?? `nocache:${request.id}`}`,
      () =>
        runNonStreamingFailover(app, runtime, {
          effectiveRequest,
          candidates: resolveCandidates(runtime, effectiveRequest),
          clientAbort,
          traceHeaders,
          tenant,
          requestId: request.id,
        }),
    );

    if (outcome.deduped) {
      // Another concurrent caller already paid for the upstream call.
      const leader = outcome.value;
      await emitMeterRecord(runtime, {
        ...buildMeterInput(request.id, tenant, effectiveRequest, envelopeOf(leader)),
        cacheHit: true,
        latencyMs: Date.now() - Number.parseInt(leader.startedAt, 10),
      });
      void reply.header("x-axiom-provider", leader.provider);
      void reply.header("x-axiom-model", effectiveRequest.model);
      void reply.header("x-axiom-cache", "DEDUPED");
      return reply.status(leader.status).send(leader.jsonText);
    }

    const leader = outcome.value;

    // Meter the upstream delivery exactly once (leader only).
    await emitMeterRecord(runtime, {
      requestId: request.id,
      tenant,
      request: effectiveRequest,
      completionText: leader.completionText,
      reported: leader.reported,
      provider: leader.provider,
      streamed: false,
      latencyMs: leader.latencyMs,
      upstreamStatus: leader.status,
      cacheHit: false,
    });

    if (cacheKey !== null) {
      await runtime.inputCache.store(cacheKey, {
        provider: leader.provider,
        model: effectiveRequest.model,
        status: leader.status,
        contentType: "application/json",
        body: leader.jsonText,
        streamed: false,
        usage: {
          promptTokens: leader.reported?.promptTokens ?? 0,
          completionTokens: leader.reported?.completionTokens ?? 0,
        },
      });
    }

    void reply.header("x-axiom-provider", leader.provider);
    void reply.header("x-axiom-model", effectiveRequest.model);
    if (cacheKey !== null) {
      void reply.header("x-axiom-cache", "MISS");
    }
    return reply.status(leader.status).send(leader.jsonText);
  });
}

/* -------------------------------- helpers -------------------------------- */

function resolveCandidates(runtime: GatewayRuntime, request: ChatCompletionRequest) {
  const catalogEntry = runtime.registry.get(request.model);
  const candidates = runtime.router.resolve(request.model, catalogEntry?.provider);
  if (candidates.length === 0) {
    throw errors.modelNotAllowed(request.model);
  }
  return candidates;
}

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
      ...(m.cache_control !== undefined ? { cacheControl: m.cache_control } : {}),
    })),
    tools: wire.tools?.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters_json_schema !== undefined
        ? { parametersJsonSchema: tool.parameters_json_schema as Record<string, unknown> }
        : {}),
    })),
    temperature: wire.temperature,
    topP: wire.top_p,
    maxTokens: wire.max_tokens,
    stopSequences:
      Array.isArray(wire.stop) ? wire.stop : wire.stop !== undefined ? [wire.stop] : undefined,
    stream: wire.stream ?? false,
    requestId,
    ...(wire.prompt_cache_key !== undefined ? { promptCacheKey: wire.prompt_cache_key } : {}),
  };
}

function readCompletionText(json: unknown): string {
  const choices = (json as { choices?: Array<{ message?: { content?: string } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

interface FailoverDeps {
  effectiveRequest: ChatCompletionRequest;
  candidates: ProviderAdapter[];
  clientAbort: AbortController;
  traceHeaders: Record<string, string>;
  tenant?: TenantContext;
  requestId?: string;
}

/**
 * Shared candidate iteration; throws the Axiom error contract when every
 * route is exhausted.
 */
async function attemptProviders<T>(
  app: FastifyInstance,
  runtime: GatewayRuntime,
  deps: FailoverDeps,
  onSuccess: (
    adapterId: string,
    result: Extract<UpstreamResult, { ok: true }>,
    startedAt: number,
  ) => Promise<T>,
): Promise<T> {
  let lastFailure:
    | { reason: string; status?: number; message?: string; provider: string }
    | undefined;
  const attempts: Array<{ provider: string; status?: number; reason?: string; message?: string }> = [];

  for (const adapter of deps.candidates) {
    if (!runtime.breaker.canAttempt(adapter.id)) {
      continue;
    }
    const startedAt = Date.now();
    // O1: Gen-AI semantic-convention span so the ops plane can reconstruct
    // tokens/model/tenant per upstream attempt from ClickHouse traces.
    const result = await withLlmSpan(
      app.telemetry.tracer,
      `gateway.upstream.${adapter.id}`,
      {
        [llmAttr.system]: adapter.id,
        [llmAttr.requestModel]: deps.effectiveRequest.model,
        ...(deps.tenant !== undefined
          ? { [axiomAttr.tenantId]: deps.tenant.tenantId, [axiomAttr.projectId]: deps.tenant.projectId }
          : {}),
        ...(deps.requestId !== undefined ? { [axiomAttr.requestId]: deps.requestId } : {}),
      },
      async () => {
        const callResult = await (deps.effectiveRequest.stream === true
          ? adapter.stream({ body: deps.effectiveRequest, signal: deps.clientAbort.signal, headers: deps.traceHeaders })
          : adapter.complete({ body: deps.effectiveRequest, signal: deps.clientAbort.signal, headers: deps.traceHeaders }));
        const outcome: LlmCallOutcome = {};
        if (callResult.ok && callResult.json !== undefined) {
          const reported = extractReportedUsage(callResult.json);
          if (reported?.promptTokens !== undefined || reported?.completionTokens !== undefined) {
            const inputTokens = reported.promptTokens ?? 0;
            const outputTokens = reported.completionTokens ?? 0;
            outcome.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
          }
        }
        return { value: callResult, outcome };
      },
    );

    if (!result.ok) {
      runtime.breaker.recordFailure(adapter.id);
      lastFailure = {
        reason: result.reason,
        status: result.status,
        message: result.message,
        provider: adapter.id,
      };
      attempts.push({
        provider: adapter.id,
        status: result.status,
        reason: result.reason,
        message: result.message?.slice(0, 300),
      });
      continue;
    }
    runtime.breaker.recordSuccess(adapter.id);
    return onSuccess(adapter.id, result, startedAt);
  }

  if (lastFailure?.status === 429) {
    throw new AxiomError(
      "AXIOM_UPSTREAM_UNAVAILABLE",
      `Upstream provider '${lastFailure.provider}' rate limited the request.`,
      { retryable: true, details: { attempts } },
    );
  }
  throw errors.allUpstreamsFailed(
    attempts.length > 0
      ? attempts
      : deps.candidates.map((candidate) => ({ provider: candidate.id, reason: "breaker_open" })),
  );
}

async function runNonStreamingFailover(
  app: FastifyInstance,
  runtime: GatewayRuntime,
  deps: FailoverDeps,
): Promise<NonStreamingOutcome & { startedAt: string }> {
  return attemptProviders(app, runtime, deps, async (adapterId, result, startedAt) => {
    if (result.json === undefined) {
      throw AxiomError.from(new Error("upstream returned no body"));
    }
    return {
      status: result.status,
      jsonText: JSON.stringify(result.json),
      provider: adapterId,
      completionText: readCompletionText(result.json),
      reported: extractReportedUsage(result.json),
      latencyMs: Date.now() - startedAt,
      startedAt: String(startedAt),
    };
  }).then((value) => value as NonStreamingOutcome & { startedAt: string });
}

async function streamViaFailover(
  app: FastifyInstance,
  runtime: GatewayRuntime,
  request: FastifyRequest,
  reply: FastifyReply,
  options: FailoverDeps & { tenant: TenantContext; cacheKey: string | null },
): Promise<void> {
  await attemptProviders(app, runtime, options, async (adapterId, result, startedAt) => {
    if (result.stream === undefined) {
      throw AxiomError.from(new Error("upstream returned no stream"));
    }
    const streamHeaders: Record<string, string> = {
      "x-axiom-provider": adapterId,
      "x-axiom-model": options.effectiveRequest.model,
      ...(options.cacheKey !== null ? { "x-axiom-cache": "MISS" } : {}),
    };

    await pipeStreamingResponse(reply, result.stream, {
      headers: streamHeaders,
      onFinish: async (state) => {
        await emitMeterRecord(runtime, {
          requestId: request.id,
          tenant: options.tenant,
          request: options.effectiveRequest,
          completionText: state.completionText,
          reported: state.reported,
          provider: adapterId,
          streamed: true,
          latencyMs: Date.now() - startedAt,
          upstreamStatus: result.status,
          cacheHit: false,
        });
      },
      collectFor: options.cacheKey !== null
        ? {
            maxBytes: runtime.inputCache.options.maxEntryBytes,
            onComplete: async (raw, reported) => {
              if (raw === null || options.cacheKey === null || reported === undefined) {
                return;
              }
              await runtime.inputCache.store(options.cacheKey, {
                provider: adapterId,
                model: options.effectiveRequest.model,
                status: 200,
                contentType: "text/event-stream",
                body: raw,
                streamed: true,
                usage: {
                  promptTokens: reported.promptTokens ?? 0,
                  completionTokens: reported.completionTokens ?? 0,
                },
              });
            },
          }
        : undefined,
    });
  }).then((value) => value as void);
}

/* ------------------------- cached delivery paths ------------------------- */

function envelopeOf(leader: NonStreamingOutcome & { startedAt: string }): CacheEnvelope {
  return {
    provider: leader.provider,
    model: "",
    status: leader.status,
    contentType: "application/json",
    body: leader.jsonText,
    streamed: false,
    usage: {
      promptTokens: leader.reported?.promptTokens ?? 0,
      completionTokens: leader.reported?.completionTokens ?? 0,
    },
    createdAt: Number.parseInt(leader.startedAt, 10),
  };
}

function buildMeterInput(
  requestId: string,
  tenant: TenantContext,
  request: ChatCompletionRequest,
  envelope: CacheEnvelope,
): {
  requestId: string;
  tenant: TenantContext;
  request: ChatCompletionRequest;
  completionText: string;
  reported: ReportedUsage | undefined;
  provider: string;
  streamed: boolean;
  latencyMs: number;
  upstreamStatus: number;
  cacheHit: boolean;
} {
  return {
    requestId,
    tenant,
    request,
    completionText: "",
    reported: {
      promptTokens: envelope.usage.promptTokens,
      completionTokens: envelope.usage.completionTokens,
    },
    provider: envelope.provider,
    streamed: envelope.streamed,
    latencyMs: 0,
    upstreamStatus: envelope.status,
    cacheHit: true,
  };
}

function deliverCached(reply: FastifyReply, envelope: CacheEnvelope, marker: "HIT"): void {
  reply.hijack();
  const headers: Record<string, string | number> = {
    "content-type": envelope.contentType,
    "x-axiom-provider": envelope.provider,
    "x-axiom-cache": marker,
  };
  if (!envelope.streamed) {
    headers["content-length"] = Buffer.byteLength(envelope.body, "utf8");
  } else {
    headers["cache-control"] = "no-cache";
  }
  reply.raw.writeHead(envelope.status, headers);
  reply.raw.end(envelope.body);
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
    cacheHit?: boolean;
  },
): Promise<void> {
  const outcome = resolveUsage(input.request, input.completionText, input.reported);
  const entry = runtime.registry.get(input.request.model);
  const costUsd = input.cacheHit === true ? 0 : computeCostUsd(entry, outcome, input.provider);

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
      cachedInputTokens: outcome.cachedInputTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheHit: input.cacheHit === true,
    });
  }
}

/* ------------------------------ SSE plumbing ----------------------------- */

interface TapState {
  completionText: string;
  reported: ReportedUsage | undefined;
}

/**
 * Streams the upstream SSE body to the client byte-for-byte with full
 * backpressure, extracting delta text + reported usage along the way, and
 * optionally capturing the raw frame sequence for cache replay.
 */
async function pipeStreamingResponse(
  reply: FastifyReply,
  upstream: ReadableStream<Uint8Array>,
  hooks: {
    /** Extra response headers (hijacked sockets bypass Fastify's store). */
    headers?: Record<string, string>;
    onFinish: (state: TapState) => Promise<void>;
    collectFor?: {
      maxBytes: number;
      onComplete: (raw: string | null, reported: ReportedUsage | undefined) => Promise<void>;
    };
  },
): Promise<void> {
  // We drive the raw socket ourselves from here on.
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...hooks.headers,
  });

  const state: TapState = { completionText: "", reported: undefined };
  const collector = hooks.collectFor;
  const decoder = new TextDecoder();
  let rawText = "";
  let overBudget = false;

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

  try {
    for await (const chunk of Readable.fromWeb(upstream)) {
      const bytes = chunk as Uint8Array;
      if (collector !== undefined && !overBudget) {
        rawText += decoder.decode(bytes, { stream: true });
        if (Buffer.byteLength(rawText, "utf8") > collector.maxBytes) {
          overBudget = true;
          rawText = "";
        }
      }
      const forwarded = tap.push(bytes);
      if (!reply.raw.write(forwarded)) {
        await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
      }
    }
    tap.finish();
  } catch {
    // Client disconnect or upstream reset: truncated streams are metered
    // but never cached.
    overBudget = true;
    rawText = "";
  }

  // Metering/caching must never break the response path.
  await hooks.onFinish(state).catch(() => undefined);
  if (collector !== undefined) {
    await collector
      .onComplete(overBudget ? null : rawText, state.reported)
      .catch(() => undefined);
  }

  if (!reply.raw.writableEnded) {
    reply.raw.end();
  }
}
