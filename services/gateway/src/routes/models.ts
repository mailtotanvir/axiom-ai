import type { FastifyInstance } from "fastify";

import type { ModelInfo, ProviderId } from "@axiom-ai/core";

/**
 * Static bootstrap catalog (Phase 0). Phase 1 (G1) replaces this with the
 * capability registry assembled from live provider adapters.
 */
function model(
  id: string,
  provider: ProviderId,
  contextWindowTokens: number,
  maxOutputTokens: number,
): ModelInfo {
  return {
    id,
    provider,
    contextWindowTokens,
    maxOutputTokens,
    supportsStreaming: true,
    supportsTools: true,
    modalities: ["text"],
  };
}

const BOOTSTRAP_MODELS: readonly ModelInfo[] = [
  model("gemini-3.6-flash", "gemini", 1_000_000, 8192),
  model("llama-3.3-70b-versatile", "groq", 131_072, 32_768),
  model("mistral-large-latest", "mistral", 131_072, 32_768),
  model("deepseek-ai/DeepSeek-V3", "siliconflow", 65_536, 16_384),
  model("meta/llama-3.1-70b-instruct", "nvidia-nim", 131_072, 32_768),
];

interface ModelsResponse {
  object: "list";
  data: ReadonlyArray<ModelInfo & { owned_by: string }>;
}

export function registerModelRoutes(app: FastifyInstance): void {
  app.get<{ Reply: ModelsResponse }>("/v1/models", async () => ({
    object: "list",
    data: BOOTSTRAP_MODELS.map((info) => ({ ...info, owned_by: info.provider })),
  }));
}
