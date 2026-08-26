/**
 * A/B experiment engine (O4, gateway side). Polls the ops control plane for
 * running-experiment rules, resolves sticky deterministic assignments per
 * request, and reports assignments back asynchronously. Failures degrade to
 * "no experiment" — the proxy path never breaks because of experiments.
 */

import { createHash } from "node:crypto";

export interface ExperimentRule {
  experimentId: string;
  tenantId: string;
  name: string;
  salt: string;
  /** Only requests for these models participate; absent = all models. */
  targetingModels?: string[];
  arms: Array<{
    name: string;
    weight: number;
    model?: string;
    template?: string;
  }>;
}

export interface RulesResponse {
  rules: ExperimentRule[];
  unresolved: Array<{ experimentId: string; arm: string; reason: string }>;
}

export interface Assignment {
  experimentId: string;
  experimentName: string;
  arm: string;
  modelOverride?: string;
  template?: string;
  /** sha256 hex of the sticky key — what the control plane stores. */
  keyHash: string;
}

/** Total bucket space; weights are integer percentages (×100 buckets). */
const BUCKETS = 10_000;

export interface EngineDeps {
  controlPlaneUrl?: string;
  internalSecret: string;
  cacheTtlMs: number;
  fetchImpl?: typeof fetch;
  loadRules?: () => Promise<RulesResponse>;
  reportAssignment?: (
    experimentId: string,
    payload: { arm: string; keyHash: string; requestId?: string },
  ) => void;
  logger?: { warn: (message: string) => void; debug: (message: string) => void };
}

export class ExperimentEngine {
  private cached: RulesResponse | undefined;
  private fetchedAt = 0;
  private inflight: Promise<RulesResponse> | undefined;
  private readonly reported = new Map<string, Assignment>();

  constructor(private readonly deps: EngineDeps) {}

  /**
   * Resolves the assignment for one request, or null when no running
   * experiment matches the tenant/model pair. Deterministic per
   * (experiment salt, sticky key): the same caller always lands in the
   * same arm while weights stay unchanged.
   */
  async resolve(
    tenantId: string,
    requestedModel: string,
    stickyKey: string,
  ): Promise<Assignment | null> {
    let rules: RulesResponse;
    try {
      rules = await this.getRules();
    } catch {
      return null;
    }

    const rule = rules.rules.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        (candidate.targetingModels === undefined ||
          candidate.targetingModels.includes(requestedModel)),
    );
    if (rule === undefined || rule.arms.length === 0) {
      return null;
    }

    const keyHash = hashKey(stickyKey);
    const bucket = bucketOf(rule.salt, stickyKey);
    const ordered = [...rule.arms].sort((a, b) => a.name.localeCompare(b.name));
    let cumulative = 0;
    let selected = ordered[ordered.length - 1]!;
    for (const arm of ordered) {
      cumulative += arm.weight * 100;
      if (bucket < cumulative) {
        selected = arm;
        break;
      }
    }

    const assignment: Assignment = {
      experimentId: rule.experimentId,
      experimentName: rule.name,
      arm: selected.name,
      ...(selected.model !== undefined ? { modelOverride: selected.model } : {}),
      ...(selected.template !== undefined ? { template: selected.template } : {}),
      keyHash,
    };

    // Report once per (experiment, key); retries and repeats stay quiet.
    const memoKey = `${rule.experimentId}:${keyHash}`;
    if (!this.reported.has(memoKey)) {
      this.remember(memoKey, assignment);
      try {
        this.reportAssignment(rule.experimentId, assignment, stickyKey);
      } catch {
        // Reporting must never break the response path.
      }
    }
    return assignment;
  }

  private remember(memoKey: string, assignment: Assignment): void {
    if (this.reported.size >= 50_000) {
      this.reported.clear();
    }
    this.reported.set(memoKey, assignment);
  }

  private reportAssignment(
    experimentId: string,
    assignment: Assignment,
    _stickyKey: string,
  ): void {
    if (this.deps.reportAssignment !== undefined) {
      this.deps.reportAssignment(experimentId, {
        arm: assignment.arm,
        keyHash: assignment.keyHash,
      });
      return;
    }
    const base = this.deps.controlPlaneUrl?.replace(/\/$/, "");
    if (base === undefined) {
      return;
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    void fetchImpl(`${base}/v1/experiments/${experimentId}/assignments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axiom-internal-secret": this.deps.internalSecret,
      },
      body: JSON.stringify({ arm: assignment.arm, keyHash: assignment.keyHash }),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  }

  private async getRules(): Promise<RulesResponse> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.fetchedAt < this.deps.cacheTtlMs) {
      return this.cached;
    }
    if (this.inflight === undefined) {
      this.inflight = this.fetchRules().finally(() => {
        this.inflight = undefined;
      });
    }
    try {
      const fresh = await this.inflight;
      this.cached = fresh;
      this.fetchedAt = now;
      return fresh;
    } catch (error) {
      if (this.cached !== undefined) {
        // Serve stale rules when the control plane hiccups.
        this.deps.logger?.warn("experiment rules refresh failed; serving stale");
        return this.cached;
      }
      this.deps.logger?.debug(
        `experiment rules unavailable: ${error instanceof Error ? error.message : "error"}`,
      );
      throw error;
    }
  }

  private async fetchRules(): Promise<RulesResponse> {
    if (this.deps.loadRules !== undefined) {
      return this.deps.loadRules();
    }
    const base = this.deps.controlPlaneUrl;
    if (base === undefined) {
      throw new Error("no control plane configured");
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${base.replace(/\/$/, "")}/v1/rules/experiments`, {
      headers: { "x-axiom-internal-secret": this.deps.internalSecret },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`rules endpoint returned HTTP ${response.status}`);
    }
    return (await response.json()) as RulesResponse;
  }
}

/** sha256 hex of the sticky key — raw ids never leave the gateway. */
export function hashKey(stickyKey: string): string {
  return createHash("sha256").update(stickyKey).digest("hex").slice(0, 32);
}

/** Deterministic bucket in [0, BUCKETS) from (salt, sticky key). */
export function bucketOf(salt: string, stickyKey: string): number {
  const digest = createHash("sha256").update(`${salt}:${stickyKey}`).digest();
  return digest.readUInt32BE(0) % BUCKETS;
}
