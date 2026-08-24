/**
 * Canonical domain types shared across every Axiom AI service.
 * These are the single source of truth for wire shapes; REST handlers,
 * gRPC messages (proto/axiom/v1), and internal events all map to them.
 */

export const AXIOM_PROTOCOL_VERSION = "v1" as const;

/* ---------------------------------- Chat ---------------------------------- */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present when role === "tool": the tool invocation this message responds to. */
  toolCallId?: string;
  name?: string;
}

export interface ChatToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  parametersJsonSchema?: Record<string, unknown>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  stream?: boolean;
  /** Opaque caller identifier propagated into traces. */
  requestId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  created: number;
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter";
}

/** One increment of a streamed completion. */
export interface ChatCompletionChunk {
  id: string;
  model: string;
  created: number;
  delta: {
    role?: ChatRole;
    content?: string;
    toolCallId?: string;
    toolName?: string;
    toolArgumentsDelta?: string;
  };
  finishReason?: ChatCompletionResponse["finishReason"];
  usage?: TokenUsage;
}

/* ------------------------------ Model catalog ------------------------------ */

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  modalities: Array<"text" | "image" | "audio">;
}

export interface ModelInfo extends ModelCapabilities {
  id: string;
  provider: ProviderId;
  /** USD per 1M tokens; used by metering for pre-flight cost estimates. */
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "mistral"
  | "siliconflow"
  | "nvidia-nim";

/* --------------------------------- Tenancy -------------------------------- */

export interface TenantContext {
  tenantId: string;
  projectId: string;
  /** Entitlements resolved from the API key record. */
  allowedModels: readonly string[];
  rateLimitTier: "free" | "pro" | "enterprise";
}

/* ------------------------------ Vector / RAG ------------------------------ */

/**
 * Tenant scoping is structural: services derive this from verified JWT
 * claims. User-supplied filters can never override it (ADR 0004).
 */
export interface TenantVectorScope {
  collection: string;
  tenantId: string;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  score: number;
  text: string;
  sourceSpan?: { startOffset: number; endOffset: number };
  metadata: Record<string, string | number | boolean>;
}

/* -------------------------------- Webhooks -------------------------------- */

export type AxiomWebhookEventType =
  | "agent.run.started"
  | "agent.run.step"
  | "agent.run.completed"
  | "agent.run.failed"
  | "ingestion.document.completed"
  | "ingestion.document.failed";

export interface AxiomWebhookEvent<T = unknown> {
  id: string;
  type: AxiomWebhookEventType;
  createdAt: string;
  tenantId: string;
  data: T;
}
