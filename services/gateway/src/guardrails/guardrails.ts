/**
 * Guardrails hook points (G7). Phase 1 establishes the interception
 * contract and a pass-through default chain; Presidio PII + NeMo policy
 * engines plug in here during Phase 5 (spec row 14).
 */

import type { ChatCompletionRequest } from "@axiom-ai/core";

export interface GuardrailContext {
  tenantId: string;
  projectId: string;
  requestId?: string;
}

export type GuardrailVerdict =
  | { action: "allow" }
  | { action: "redact"; request: ChatCompletionRequest; note: string }
  | { action: "block"; reason: string };

export interface GuardrailHook {
  readonly name: string;
  onRequest(context: GuardrailContext, request: ChatCompletionRequest): Promise<GuardrailVerdict>;
}

export class PassThroughGuardrails implements GuardrailHook {
  readonly name = "pass-through";

  async onRequest(
    _context: GuardrailContext,
    request: ChatCompletionRequest,
  ): Promise<Extract<GuardrailVerdict, { action: "allow" }>> {
    void request;
    return { action: "allow" };
  }
}

/** Sequential chain: first block wins, redactions compose left-to-right. */
export class GuardrailChain implements GuardrailHook {
  readonly name = "chain";

  constructor(private readonly hooks: readonly GuardrailHook[]) {}

  async onRequest(context: GuardrailContext, request: ChatCompletionRequest): Promise<GuardrailVerdict> {
    let current = request;
    for (const hook of this.hooks) {
      const verdict = await hook.onRequest(context, current);
      if (verdict.action === "block") {
        return verdict;
      }
      if (verdict.action === "redact") {
        current = verdict.request;
      }
    }
    return current === request ? { action: "allow" } : { action: "redact", request: current, note: "composed" };
  }
}
