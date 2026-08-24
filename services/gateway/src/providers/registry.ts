/**
 * Model catalog (G1). Static bootstrap entries carry capability + cost
 * metadata; the served catalog is the intersection of these entries and
 * providers that actually hold credentials at boot.
 */

import type { ModelInfo, ProviderId } from "@axiom-ai/core";

function entry(
  id: string,
  provider: ProviderId,
  contextWindowTokens: number,
  maxOutputTokens: number,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
): ModelInfo {
  return {
    id,
    provider,
    contextWindowTokens,
    maxOutputTokens,
    inputCostPerMillion,
    outputCostPerMillion,
    supportsStreaming: true,
    supportsTools: true,
    modalities: ["text"],
  };
}

export const BOOTSTRAP_CATALOG: readonly ModelInfo[] = [
  entry("gemini-3.6-flash", "gemini", 1_000_000, 8192, 0.1, 0.4),
  entry("openai/gpt-oss-120b", "groq", 131_072, 32_768, 0.59, 0.79),
  entry("mistral-large-latest", "mistral", 131_072, 32_768, 2.0, 6.0),
  entry("deepseek-ai/DeepSeek-V3", "siliconflow", 65_536, 16_384, 0.27, 1.1),
  entry("meta/llama-3.1-70b-instruct", "nvidia-nim", 131_072, 32_768, 0.6, 0.6),
];

export class ModelRegistry {
  private readonly byId = new Map<string, ModelInfo>();

  constructor(entries: readonly ModelInfo[]) {
    for (const item of entries) {
      this.byId.set(item.id, item);
    }
  }

  static forProviders(enabledProviders: ReadonlySet<string>): ModelRegistry {
    return new ModelRegistry(BOOTSTRAP_CATALOG.filter((m) => enabledProviders.has(m.provider)));
  }

  has(modelId: string): boolean {
    return this.byId.has(modelId);
  }

  get(modelId: string): ModelInfo | undefined {
    return this.byId.get(modelId);
  }

  list(): ModelInfo[] {
    return [...this.byId.values()];
  }
}
