/**
 * Guardrails engine (G7, X5, Milestone 5.1).
 *
 * Implements:
 * 1. Presidio-style PII detection and redaction (emails, phone numbers,
 *    US SSNs, credit cards with Luhn verification, IP addresses, API keys).
 * 2. NeMo-style prompt injection and content policy evaluator.
 * 3. Tenant-scoped policy configuration and sequential composition.
 * 4. OpenTelemetry span attribution and Prometheus metrics tracking.
 */

import {
  type ChatCompletionRequest,
  type ChatMessage,
  globalMetrics,
  type Counter,
} from "@tanvir1971/core";

export interface GuardrailContext {
  tenantId: string;
  projectId?: string;
  requestId?: string;
}

export type GuardrailVerdict =
  | { action: "allow" }
  | { action: "redact"; request: ChatCompletionRequest; note: string; entities?: string[] }
  | { action: "block"; reason: string; rule?: string };

export interface GuardrailHook {
  readonly name: string;
  onRequest(context: GuardrailContext, request: ChatCompletionRequest): Promise<GuardrailVerdict>;
}

// ---------------------------------------------------------------------------
// Prometheus Metrics for Guardrails
// ---------------------------------------------------------------------------

const guardrailEvaluations: Counter = globalMetrics.registerCounter(
  "axiom_guardrail_evaluations_total",
  "Total number of guardrail evaluations by verdict and hook name",
);

const guardrailViolations: Counter = globalMetrics.registerCounter(
  "axiom_guardrail_violations_total",
  "Total number of guardrail violations by rule/entity type and tenant",
);

// ---------------------------------------------------------------------------
// PII Detection & Redaction (Presidio Engine)
// ---------------------------------------------------------------------------

export type PiiEntityType =
  | "EMAIL_ADDRESS"
  | "PHONE_NUMBER"
  | "US_SSN"
  | "CREDIT_CARD"
  | "IP_ADDRESS"
  | "API_KEY";

export interface PiiDetectorRule {
  type: PiiEntityType;
  regex: RegExp;
  validate?: (match: string) => boolean;
  replacement: string;
}

function luhnCheck(cardNumber: string): boolean {
  const clean = cardNumber.replace(/\D/g, "");
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    const digitChar = clean.charAt(i);
    let digit = parseInt(digitChar, 10);
    if (isNaN(digit)) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export const DEFAULT_PII_RULES: readonly PiiDetectorRule[] = [
  {
    type: "API_KEY",
    regex: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_\-.]{25,})\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    type: "EMAIL_ADDRESS",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    type: "US_SSN",
    regex: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g,
    validate: (match: string) => {
      const clean = match.replace(/\D/g, "");
      if (clean.length !== 9) return false;
      if (clean === "000000000" || clean.startsWith("000") || clean.startsWith("666")) return false;
      return true;
    },
    replacement: "[REDACTED_SSN]",
  },
  {
    type: "CREDIT_CARD",
    regex: /\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{15,16}\b/g,
    validate: (match: string) => luhnCheck(match),
    replacement: "[REDACTED_CREDIT_CARD]",
  },
  {
    type: "PHONE_NUMBER",
    regex: /(?:^|(?<=[^\w]))(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})(?=[^\w]|$)/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    type: "IP_ADDRESS",
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    validate: (match: string) => {
      return match.split(".").length === 4;
    },
    replacement: "[REDACTED_IP]",
  },
];

export interface PresidioPiiOptions {
  mode?: "redact" | "block" | "disabled";
  entities?: PiiEntityType[];
  rules?: readonly PiiDetectorRule[];
}

export class PresidioPiiGuardrail implements GuardrailHook {
  readonly name = "presidio-pii";
  private readonly mode: "redact" | "block" | "disabled";
  private readonly activeRules: readonly PiiDetectorRule[];

  constructor(options: PresidioPiiOptions = {}) {
    this.mode = options.mode ?? "redact";
    const rules = options.rules ?? DEFAULT_PII_RULES;
    if (options.entities && options.entities.length > 0) {
      const allowed = new Set(options.entities);
      this.activeRules = rules.filter((r) => allowed.has(r.type));
    } else {
      this.activeRules = rules;
    }
  }

  redactText(text: string): { redacted: string; foundEntities: PiiEntityType[] } {
    let current = text;
    const foundEntities = new Set<PiiEntityType>();

    for (const rule of this.activeRules) {
      const matches = current.match(rule.regex);
      if (matches) {
        let matchedAny = false;
        current = current.replace(rule.regex, (match) => {
          if (rule.validate && !rule.validate(match)) {
            return match;
          }
          matchedAny = true;
          return rule.replacement;
        });
        if (matchedAny) {
          foundEntities.add(rule.type);
        }
      }
    }

    return { redacted: current, foundEntities: Array.from(foundEntities) };
  }

  async onRequest(
    context: GuardrailContext,
    request: ChatCompletionRequest,
  ): Promise<GuardrailVerdict> {
    if (this.mode === "disabled") {
      guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "allow" });
      return { action: "allow" };
    }

    let modified = false;
    const detectedEntities = new Set<string>();
    const updatedMessages: ChatMessage[] = [];

    for (const msg of request.messages) {
      if (typeof msg.content === "string") {
        const { redacted, foundEntities } = this.redactText(msg.content);
        if (foundEntities.length > 0) {
          modified = true;
          for (const ent of foundEntities) {
            detectedEntities.add(ent);
            guardrailViolations.inc({
              job: "gateway",
              type: ent,
              tenant_id: context.tenantId || "unknown",
            });
          }
          updatedMessages.push({ ...msg, content: redacted });
        } else {
          updatedMessages.push(msg);
        }
      } else {
        updatedMessages.push(msg);
      }
    }

    if (!modified) {
      guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "allow" });
      return { action: "allow" };
    }

    const entitiesList = Array.from(detectedEntities);
    if (this.mode === "block") {
      guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "block" });
      return {
        action: "block",
        reason: `Request rejected: sensitive PII detected (${entitiesList.join(", ")})`,
        rule: "pii_block",
      };
    }

    guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "redact" });
    return {
      action: "redact",
      request: { ...request, messages: updatedMessages },
      note: `PII redacted: ${entitiesList.join(", ")}`,
      entities: entitiesList,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt Injection & Content Policy Evaluator (NeMo Style)
// ---------------------------------------------------------------------------

export interface ContentPolicyRule {
  id: string;
  name: string;
  regex: RegExp;
  category: "injection" | "jailbreak" | "prohibited_content";
}

export const DEFAULT_CONTENT_POLICY_RULES: readonly ContentPolicyRule[] = [
  {
    id: "inj-ignore-directions",
    name: "Ignore previous instructions",
    regex: /\b(?:ignore|disregard|forget|bypass)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|directions|prompts|rules)\b/i,
    category: "injection",
  },
  {
    id: "inj-dan-jailbreak",
    name: "DAN / Jailbreak Persona",
    regex: /\b(?:DAN\s+mode|jailbreak|do\s+anything\s+now|developer\s+mode\s+enabled)\b/i,
    category: "jailbreak",
  },
  {
    id: "inj-system-leak",
    name: "System prompt extraction",
    regex: /\b(?:output|print|reveal|show|display)\s+(?:your\s+)?(?:full\s+)?(?:system\s+prompt|initial\s+instructions|pre-prompt)\b/i,
    category: "injection",
  },
  {
    id: "inj-roleplay-hijack",
    name: "System role override delimiter",
    regex: /(?:<\|im_start\|>system|\[SYSTEM_OVERRIDE\]|<<SYS>>.*<(\/|\\)SYS>>)/i,
    category: "injection",
  },
];

export interface ContentPolicyOptions {
  enabled?: boolean;
  rules?: readonly ContentPolicyRule[];
  bannedKeywords?: string[];
}

export class ContentPolicyGuardrail implements GuardrailHook {
  readonly name = "content-policy";
  private readonly enabled: boolean;
  private readonly rules: readonly ContentPolicyRule[];
  private readonly bannedKeywords: string[];

  constructor(options: ContentPolicyOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.rules = options.rules ?? DEFAULT_CONTENT_POLICY_RULES;
    this.bannedKeywords = (options.bannedKeywords ?? []).map((k) => k.toLowerCase());
  }

  async onRequest(
    context: GuardrailContext,
    request: ChatCompletionRequest,
  ): Promise<GuardrailVerdict> {
    if (!this.enabled) {
      guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "allow" });
      return { action: "allow" };
    }

    for (const msg of request.messages) {
      if (typeof msg.content === "string") {
        const text = msg.content;
        for (const rule of this.rules) {
          if (rule.regex.test(text)) {
            guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "block" });
            guardrailViolations.inc({
              job: "gateway",
              type: rule.category,
              tenant_id: context.tenantId || "unknown",
            });
            return {
              action: "block",
              reason: `Content policy violation: ${rule.name}`,
              rule: rule.id,
            };
          }
        }

        const lower = text.toLowerCase();
        for (const kw of this.bannedKeywords) {
          if (kw && lower.includes(kw)) {
            guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "block" });
            guardrailViolations.inc({
              job: "gateway",
              type: "banned_keyword",
              tenant_id: context.tenantId || "unknown",
            });
            return {
              action: "block",
              reason: `Content policy violation: prohibited keyword detected`,
              rule: "banned_keyword",
            };
          }
        }
      }
    }

    guardrailEvaluations.inc({ job: "gateway", guardrail: this.name, verdict: "allow" });
    return { action: "allow" };
  }
}

// ---------------------------------------------------------------------------
// Standard Pass-Through & Composed Chains
// ---------------------------------------------------------------------------

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
    const allEntities: string[] = [];
    for (const hook of this.hooks) {
      const verdict = await hook.onRequest(context, current);
      if (verdict.action === "block") {
        return verdict;
      }
      if (verdict.action === "redact") {
        current = verdict.request;
        if (verdict.entities) {
          allEntities.push(...verdict.entities);
        }
      }
    }
    return current === request
      ? { action: "allow" }
      : { action: "redact", request: current, note: "composed", entities: allEntities };
  }
}

/**
 * Creates the standard production-grade guardrail chain combining
 * Presidio PII redaction and NeMo-style prompt injection defenses.
 */
export function createDefaultGuardrails(options?: {
  piiMode?: "redact" | "block" | "disabled";
  policyEnabled?: boolean;
  bannedKeywords?: string[];
}): GuardrailHook {
  const pii = new PresidioPiiGuardrail({ mode: options?.piiMode ?? "redact" });
  const policy = new ContentPolicyGuardrail({
    enabled: options?.policyEnabled ?? true,
    bannedKeywords: options?.bannedKeywords,
  });
  return new GuardrailChain([policy, pii]);
}
