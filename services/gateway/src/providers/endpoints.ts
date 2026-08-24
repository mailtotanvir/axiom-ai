/**
 * Concrete provider endpoints (G1 / ADR 0006). Every entry speaks the
 * OpenAI-compatible wire format; credentials arrive from the shared env
 * contract. OpenAI/Anthropic are key-gated: absent keys simply disable them.
 */

import { OpenAiCompatibleAdapter, type OpenAiCompatibleConfig } from "./openaiCompatible.js";
import type { ProviderAdapter } from "./types.js";

interface EndpointSpec {
  baseUrl: string;
  envKey: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "GROQ_API_KEY" | "MISTRAL_API_KEY" | "SILICONFLOW_API_KEY" | "NVIDIA_NIM_API_KEY";
}

const ENDPOINTS: Record<string, EndpointSpec> = {
  openai: { baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", envKey: "SILICONFLOW_API_KEY" },
  "nvidia-nim": { baseUrl: "https://integrate.api.nvidia.com/v1", envKey: "NVIDIA_NIM_API_KEY" },
};

export function buildOpenAiCompatibleProviders(
  keys: Record<string, string | undefined>,
  timeoutMs: number,
): ProviderAdapter[] {
  return Object.entries(ENDPOINTS).map(([id, spec]) => {
    const config: OpenAiCompatibleConfig = {
      id: id as OpenAiCompatibleConfig["id"],
      baseUrl: spec.baseUrl,
      apiKey: keys[spec.envKey],
      timeoutMs,
    };
    return new OpenAiCompatibleAdapter(config);
  });
}

export { ENDPOINTS };
