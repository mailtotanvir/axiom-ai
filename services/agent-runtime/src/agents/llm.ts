/**
 * LLM access for the planning loop. Production talks to the gateway
 * (OpenAI wire format passthrough); tests substitute scripted clients.
 *
 * O1/O6: planner calls are wrapped in Gen-AI semantic-convention spans and
 * W3C trace-context is propagated to the gateway, so a single trace ID
 * follows agent runs across services.
 */

import { llmAttr, otel, withLlmSpan, type Tracer } from "@axiom-ai/core";

export interface PlannerTurn {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface PlannerRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  complete(request: PlannerRequest): Promise<PlannerTurn>;
}

export class GatewayLlmClient implements LlmClient {
  constructor(
    private readonly gatewayUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tracer?: Tracer,
  ) {}

  async complete(request: PlannerRequest): Promise<PlannerTurn> {
    if (this.apiKey === undefined || this.apiKey === "") {
      throw new Error(
        "AGENT_RUNTIME_LLM_API_KEY is not set; cannot call the gateway for planning",
      );
    }

    const run = async (): Promise<PlannerTurn> => {
      // W3C trace-context so the gateway span nests under the agent run.
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      };
      otel.propagation.inject(otel.context.active(), headers);

      const response = await this.fetchImpl(
        `${this.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            max_tokens: request.maxTokens ?? 1_024,
            // Planning decisions are parsed programmatically; keep them tight.
            temperature: 0,
          }),
          signal: request.signal ?? AbortSignal.timeout(90_000),
        },
      );
      if (!response.ok) {
        throw new Error(`gateway planning call failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      };
    };

    if (this.tracer === undefined) {
      return run();
    }
    return withLlmSpan(
      this.tracer,
      "agent.planner",
      {
        [llmAttr.system]: "gateway",
        [llmAttr.requestModel]: request.model,
        ...(request.maxTokens !== undefined
          ? { [llmAttr.maxTokens]: request.maxTokens }
          : {}),
      },
      async () => {
        const turn = await run();
        return {
          value: turn,
          outcome: {
            usage: { ...turn.usage, totalTokens: turn.usage.promptTokens + turn.usage.completionTokens },
          },
        };
      },
    );
  }
}
