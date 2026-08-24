/**
 * Step-based agent orchestrator (A2): plan → tool call → observe → repeat.
 *
 * Durability: every step appends to the run event store *before* the next
 * action starts; a killed worker replays events and resumes from the last
 * durable point, making BullMQ retries idempotent.
 *
 * Budgets: max steps and cumulative planner tokens hard-stop the loop with
 * a structured failure. Approval gates pause runs awaiting external consent.
 */

import { assembleContext } from "./context.js";
import type { LlmClient } from "./llm.js";
import type { RunEventStore } from "./eventStore.js";
import { deriveState } from "./eventStore.js";
import type {
  AgentRunJob,
  RunEvent,
  RunEventType,
  RunStatus,
} from "./types.js";
import type { ToolRegistry } from "../sandbox/registry.js";

export interface PlannerDecisionToolCall {
  type: "tool_call";
  tool: string;
  arguments: Record<string, unknown>;
}

export interface PlannerDecisionFinal {
  type: "final";
  text: string;
}

export type PlannerDecision = PlannerDecisionToolCall | PlannerDecisionFinal;

export function parseDecision(rawText: string): PlannerDecision | undefined {
  // Tolerate code fences and surrounding prose: take the first {...} block
  // that parses and carries a known decision type.
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], rawText];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        type?: string;
        tool?: string;
        arguments?: unknown;
        text?: string;
      };
      if (parsed.type === "tool_call" && typeof parsed.tool === "string") {
        return {
          type: "tool_call",
          tool: parsed.tool,
          arguments:
            parsed.arguments !== null && typeof parsed.arguments === "object"
              ? (parsed.arguments as Record<string, unknown>)
              : {},
        };
      }
      if (parsed.type === "final" && typeof parsed.text === "string") {
        return { type: "final", text: parsed.text };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface OrchestratorDeps {
  llm: LlmClient;
  eventStore: RunEventStore;
  registry: ToolRegistry;
  /** Model context windows for budget packing (modelId → tokens). */
  modelWindows: ReadonlyMap<string, number>;
  defaultWindowTokens?: number;
  now?: () => Date;
}

export class AgentOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async status(runId: string): Promise<RunStatus | undefined> {
    const events = await this.deps.eventStore.list(runId);
    if (events.length === 0) {
      return undefined;
    }
    const derived = deriveState(events);
    return { runId, ...derived };
  }

  async events(runId: string): Promise<RunEvent[]> {
    return this.deps.eventStore.list(runId);
  }

  async execute(job: AgentRunJob): Promise<RunStatus> {
    const events = await this.deps.eventStore.list(job.runId);

    // Idempotency: a terminal run never re-executes.
    const existing = deriveState(events);
    if (existing.state === "completed" || existing.state === "failed") {
      return { runId: job.runId, ...existing };
    }

    if (events.length === 0) {
      await this.append(events, job, "run.started", {
        definition: job.definition,
        idempotencyKey: job.idempotencyKey,
      });
    }

    // Replay transcript from events.
    const transcript: Array<{ role: "system" | "user" | "assistant"; content: string }> =
      [...job.input.messages];
    for (const event of events) {
      if (event.type === "step.llm") {
        const data = event.data as { decision: PlannerDecision };
        if (data.decision.type === "tool_call") {
          transcript.push({ role: "assistant", content: JSON.stringify(data.decision) });
        } else if (data.decision.type === "final") {
          transcript.push({ role: "assistant", content: data.decision.text });
        }
      } else if (event.type === "step.tool") {
        const data = event.data as { tool: string; result: string };
        transcript.push({ role: "user", content: `TOOL_RESULT ${data.tool}: ${data.result}` });
      } else if (event.type === "approval.granted") {
        transcript.push({ role: "user", content: "APPROVAL: granted — you may proceed." });
      }
    }

    if (existing.state === "awaiting_approval" && job.approval === undefined) {
      return { runId: job.runId, ...deriveState(events) };
    }
    if (existing.state === "awaiting_approval" && job.approval !== undefined) {
      await this.append(events, job, "approval.granted", { grantedBy: job.approval.grantedBy });
      transcript.push({ role: "user", content: "APPROVAL: granted — you may proceed." });
    }

    while (true) {
      const derived = deriveState(events);
      if (derived.steps >= job.definition.maxSteps) {
        return this.fail(events, job, `max steps (${job.definition.maxSteps}) exceeded`);
      }
      if (derived.tokensUsed >= job.definition.maxTotalTokens) {
        return this.fail(events, job, `token budget (${job.definition.maxTotalTokens}) exhausted`);
      }

      const context = assembleContext({
        modelWindowTokens:
          this.deps.modelWindows.get(job.definition.model) ??
          this.deps.defaultWindowTokens ??
          131_072,
        reservedOutputTokens: 1_024,
        systemPrompt: job.definition.systemPrompt,
        toolDocs:
          job.definition.tools !== undefined && job.definition.tools.length > 0
            ? this.deps.registry.describe(job.definition.tools)
            : undefined,
        history: transcript,
      });

      const turn = await this.deps.llm.complete({
        model: job.definition.model,
        messages: context.messages,
        maxTokens: 1_024,
      });

      const decision = parseDecision(turn.text);
      if (decision === undefined) {
        await this.append(events, job, "step.llm", { usage: turn.usage, parseError: turn.text.slice(0, 200) });
        return this.fail(events, job, "planner produced an unparseable decision");
      }

      await this.append(events, job, "step.llm", { decision, usage: turn.usage });
      transcript.push({
        role: "assistant",
        content: JSON.stringify(decision),
      });

      if (decision.type === "final") {
        await this.append(events, job, "run.completed", { output: decision.text });
        return this.deriveFinal(job.runId, events);
      }

      // Tool call path.
      if (
        job.definition.requiresApproval === true &&
        !events.some((e) => e.type === "approval.granted")
      ) {
        await this.append(events, job, "approval.requested", {
          tool: decision.tool,
          arguments: decision.arguments,
        });
        return this.deriveFinal(job.runId, events);
      }

      const execution = await this.deps.registry.execute(decision.tool, decision.arguments);
      await this.append(events, job, "step.tool", {
        tool: decision.tool,
        ok: execution.ok,
        result: execution.payload.slice(0, 8_192),
      });
      transcript.push({
        role: "user",
        content: `TOOL_RESULT ${decision.tool}: ${execution.payload}`,
      });
    }
  }

  private async deriveFinal(runId: string, _events: RunEvent[]): Promise<RunStatus> {
    const events = await this.deps.eventStore.list(runId);
    return { runId, ...deriveState(events) };
  }

  private append(
    eventsRef: RunEvent[],
    job: AgentRunJob,
    type: RunEventType,
    data: unknown,
  ): Promise<void> {
    // Keep the in-memory replay list in sync without re-querying.
    return this.deps.eventStore.append({ runId: job.runId, type, at: new Date().toISOString(), data }).then((stored) => {
      eventsRef.push(stored);
    });
  }

  private async fail(
    events: RunEvent[],
    job: AgentRunJob,
    reason: string,
  ): Promise<RunStatus> {
    await this.deps.eventStore.append({
      runId: job.runId,
      type: "run.failed",
      at: new Date().toISOString(),
      data: { reason },
    });
    void events;
    return this.deriveFinal(job.runId, events);
  }
}
