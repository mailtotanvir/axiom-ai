/**
 * LLM access for the planning loop. Production talks to the gateway
 * (OpenAI wire format passthrough); tests substitute scripted clients.
 */

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
  ) {}

  async complete(request: PlannerRequest): Promise<PlannerTurn> {
    if (this.apiKey === undefined || this.apiKey === "") {
      throw new Error(
        "AGENT_RUNTIME_LLM_API_KEY is not set; cannot call the gateway for planning",
      );
    }
    const response = await this.fetchImpl(`${this.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1_024,
        // Planning decisions are parsed programmatically; keep them tight.
        temperature: 0,
      }),
      signal: request.signal ?? AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw new Error(`gateway planning call failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}
