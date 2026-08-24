import type { FastifyInstance } from "fastify";

import { ModelRegistry } from "../providers/registry.js";

interface OwnedModel {
  id: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  modalities: string[];
  owned_by: string;
}

export function registerModelRoutes(app: FastifyInstance, registry: ModelRegistry): void {
  app.get<{ Reply: { object: "list"; data: OwnedModel[] } }>("/v1/models", async () => ({
    object: "list",
    data: registry.list().map((model) => ({ ...model, owned_by: model.provider })),
  }));
}
