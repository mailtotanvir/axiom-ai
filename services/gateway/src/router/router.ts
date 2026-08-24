/**
 * Failover router (G5). Resolves a requested model to an ordered candidate
 * chain: the model's own provider first, then configured fallbacks. Chains
 * are declared in GATEWAY_ROUTING and validated with Zod.
 */

import type { ProviderAdapter, ProviderId } from "../providers/types.js";

export interface RoutingConfig {
  /** Default failover chain applied to every model, in priority order. */
  defaultChain: readonly ProviderId[];
  /** Optional per-model overrides replacing the default chain. */
  overrides?: Record<string, readonly ProviderId[]>;
}

export class Router {
  constructor(
    private readonly adapters: ReadonlyMap<string, ProviderAdapter>,
    private readonly config: RoutingConfig,
  ) {}

  /**
   * Returns configured adapters to try in order. Providers that are not
   * configured (no key) or unknown are skipped.
   */
  resolve(modelId: string, provider: ProviderId | undefined): ProviderAdapter[] {
    const chain = this.config.overrides?.[modelId] ?? [provider, ...this.config.defaultChain].filter(
      (value): value is ProviderId => value !== undefined,
    );

    const candidates: ProviderAdapter[] = [];
    const seen = new Set<ProviderId>();
    for (const id of chain) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const adapter = this.adapters.get(id);
      if (adapter?.isConfigured()) {
        candidates.push(adapter);
      }
    }
    return candidates;
  }
}
