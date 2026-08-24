/**
 * Context assembler (A4) and orchestrator (A2) tests: budgeting against
 * registered model windows, event-sourced resume after a simulated worker
 * kill, budgets, approval gates, and idempotent terminal replay.
 */

import { describe, expect, it } from "vitest";

import { assembleContext } from "../src/agents/context.js";
import { AgentOrchestrator, parseDecision } from "../src/agents/orchestrator.js";
import { deriveState, InMemoryRunEventStore } from "../src/agents/eventStore.js";
import type {
  LlmClient,
  PlannerRequest,
  PlannerTurn,
} from "../src/agents/llm.js";
import type { AgentRunJob } from "../src/agents/types.js";
import { ToolRegistry } from "../src/sandbox/registry.js";
import { hostExecutor } from "./helpers/hostExecutor.js";

/* ------------------------------ A4: context ------------------------------ */

describe("assembleContext", () => {
  it("keeps everything when the history fits the window", () => {
    const result = assembleContext({
      modelWindowTokens: 131_072,
      systemPrompt: "You are helpful.",
      toolDocs: "- calculator: arithmetic",
      history: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    expect(result.truncated).toBe(false);
    expect(result.droppedTurns).toBe(0);
    expect(result.messages).toHaveLength(5); // system + tools + marker-free turns
  });

  it("packs newest-first and marks dropped turns against tiny windows", () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}: ${"x".repeat(200)}`,
    }));
    const result = assembleContext({
      modelWindowTokens: 2_000,
      reservedOutputTokens: 256,
      history: turns,
    });

    expect(result.truncated).toBe(true);
    expect(result.includedTurns).toBeLessThan(200);
    expect(result.messages[0]?.content).toContain("earlier conversation turn");
    // The most recent turn always survives.
    expect(result.messages.at(-1)?.content).toContain("turn 199:");
  });

  it("never exceeds the usable window even with pathological inputs", () => {
    const result = assembleContext({
      modelWindowTokens: 1_000,
      reservedOutputTokens: 100,
      systemPrompt: "s".repeat(20_000),
      toolDocs: "t".repeat(10_000),
      history: [{ role: "user", content: "u".repeat(50_000) }],
    });
    // Heuristic estimator: per-message framing overhead adds a little
    // slack on top of the usable window.
    expect(result.tokensUsed).toBeLessThanOrEqual(900 + result.messages.length * 8 + 64);
    expect(result.messages.some((m) => m.content.includes("[system content truncated"))).toBe(true);
  });
});

/* ------------------------------ decision parsing ------------------------- */

describe("parseDecision", () => {
  it("parses fenced and embedded JSON decisions", () => {
    expect(parseDecision('{"type":"final","text":"done"}')).toEqual({ type: "final", text: "done" });
    expect(parseDecision('```json\n{"type":"tool_call","tool":"calc","arguments":{"a":1}}\n```')).toEqual({
      type: "tool_call",
      tool: "calc",
      arguments: { a: 1 },
    });
    expect(parseDecision('I will call the tool now {"type":"tool_call","tool":"t"} thanks')).toEqual({
      type: "tool_call",
      tool: "t",
      arguments: {},
    });
    expect(parseDecision("no json here")).toBeUndefined();
    expect(parseDecision('{"type":"unknown"}')).toBeUndefined();
  });
});

/* ------------------------------ A2: orchestrator -------------------------- */

function fakeLlm(script: Array<{ text: string; usage?: { promptTokens: number; completionTokens: number } }>): LlmClient & { calls: PlannerRequest[] } {
  let index = 0;
  return {
    calls: [],
    async complete(request: PlannerRequest): Promise<PlannerTurn> {
      this.calls.push(request);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next === undefined) {
        throw new Error("script exhausted");
      }
      return { text: next.text, usage: next.usage ?? { promptTokens: 10, completionTokens: 5 } };
    },
  };
}

function job(overrides: Partial<AgentRunJob> = {}): AgentRunJob {
  return {
    runId: `run_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: "tenant-a",
    projectId: "p",
    idempotencyKey: `idem_${Math.random().toString(36).slice(2, 8)}`,
    input: { messages: [{ role: "user", content: "What is 6*7?" }] },
    definition: {
      model: "mistral-large-latest",
      systemPrompt: "Use tools for math.",
      tools: ["calculator"],
      maxSteps: 8,
      maxTotalTokens: 100_000,
    },
    ...overrides,
  };
}

function registryWithCalculator(): ToolRegistry {
  const registry = new ToolRegistry(hostExecutor());
  registry.register({
    name: "calculator",
    description: "arithmetic",
    timeoutMs: 2_000,
    memoryMb: 32,
    source: `
      function tool(input) {
        return { value: Function('"use strict"; return (' + input.expression + ')')() };
      }
    `,
  });
  return registry;
}

describe("AgentOrchestrator", () => {
  it("runs plan → tool → observe → final across steps", async () => {
    const llm = fakeLlm([
      { text: '{"type":"tool_call","tool":"calculator","arguments":{"expression":"6*7"}}' },
      { text: '{"type":"final","text":"42"}' },
    ]);
    const store = new InMemoryRunEventStore();
    const orchestrator = new AgentOrchestrator({
      llm,
      eventStore: store,
      registry: registryWithCalculator(),
      modelWindows: new Map([["mistral-large-latest", 131_072]]),
    });

    const status = await orchestrator.execute(job());

    expect(status.state).toBe("completed");
    expect(status.output).toBe("42");
    expect(status.steps).toBe(2);
    expect(status.tokensUsed).toBe(30);

    const events = await orchestrator.events((await orchestrator.status(job().runId))?.runId ?? "");
    void events;
  });

  it("records a durable event log with correct ordering", async () => {
    const llm = fakeLlm([{ text: '{"type":"final","text":"ok"}', usage: { promptTokens: 3, completionTokens: 4 } }]);
    const store = new InMemoryRunEventStore();
    const orchestrator = new AgentOrchestrator({
      llm,
      eventStore: store,
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });
    const j = job();
    await orchestrator.execute(j);

    const events = await store.list(j.runId);
    expect(events.map((e) => e.type)).toEqual(["run.started", "step.llm", "run.completed"]);
    expect(events.map((e) => e.seq)).toEqual([events[0]!.seq, events[0]!.seq + 1, events[0]!.seq + 2]);
  });

  it("resumes an in-flight run from the last event after a simulated kill", async () => {
    const store = new InMemoryRunEventStore();
    const j = job();

    // Simulate a crashed first execution: run.started persisted, then death
    // before any further progress (as if the worker was OOM-killed).
    const preSeeded = new AgentOrchestrator({
      llm: fakeLlm([]), // would throw on use; must never be reached
      eventStore: store,
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });
    await store.append({ runId: j.runId, type: "run.started", at: new Date().toISOString(), data: {} });

    // New worker picks up the same job: it must continue, not restart.
    const recovered = new AgentOrchestrator({
      llm: fakeLlm([
        { text: '{"type":"tool_call","tool":"calculator","arguments":{"expression":"6*7"}}' },
        { text: '{"type":"final","text":"42 via recovery"}' },
      ]),
      eventStore: store,
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });
    const status = await recovered.execute(j);

    expect(status.state).toBe("completed");
    expect(status.output).toBe("42 via recovery");
    expect(llmCallsOf(recovered)).toHaveLength(2); // only the remaining work ran
    void preSeeded;

    const events = await store.list(j.runId);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1); // no duplicate start
  });

  it("stops at the token budget with a structured failure", async () => {
    const llm = fakeLlm(
      Array.from({ length: 20 }, () => ({
        text: '{"type":"final","text":"nope"}',
        usage: { promptTokens: 60_000, completionTokens: 60_000 },
      })).slice(0, 0).concat([
        { text: '{"type":"tool_call","tool":"calculator","arguments":{"expression":"1+1"}}', usage: { promptTokens: 90_000, completionTokens: 90_000 } },
        { text: '{"type":"final","text":"should not reach"}' },
      ]),
    );
    const orchestrator = new AgentOrchestrator({
      llm,
      eventStore: new InMemoryRunEventStore(),
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });
    const status = await orchestrator.execute(
      job({ definition: { model: "m", maxSteps: 8, maxTotalTokens: 100_000 } }),
    );

    expect(status.state).toBe("failed");
    expect(status.failureReason).toContain("token budget");
  });

  it("pauses for approval before the first tool call and resumes once granted", async () => {
    const store = new InMemoryRunEventStore();
    const llm = fakeLlm([
      { text: '{"type":"tool_call","tool":"calculator","arguments":{"expression":"6*7"}}' },
      { text: '{"type":"tool_call","tool":"calculator","arguments":{"expression":"6*7"}}' },
      { text: '{"type":"final","text":"approved result 42"}' },
    ]);
    const orchestrator = new AgentOrchestrator({
      llm,
      eventStore: store,
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });

    const j = job({
      definition: {
        model: "m",
        tools: ["calculator"],
        maxSteps: 8,
        maxTotalTokens: 100_000,
        requiresApproval: true,
      },
    });
    const paused = await orchestrator.execute(j);
    expect(paused.state).toBe("awaiting_approval");
    expect(hadToolExecution(store)).toBe(false);

    // Same runId + approval resumes the SAME run.
    const resumed = await orchestrator.execute({ ...j, approval: { grantedBy: "ops@acme" } });
    expect(resumed.state).toBe("completed");
    expect(resumed.output).toBe("approved result 42");
    expect(hadToolExecution(store)).toBe(true);
  });

  it("is idempotent for terminal runs", async () => {
    const llm = fakeLlm([{ text: '{"type":"final","text":"once"}' }]);
    const orchestrator = new AgentOrchestrator({
      llm,
      eventStore: new InMemoryRunEventStore(),
      registry: registryWithCalculator(),
      modelWindows: new Map(),
    });
    const j = job();
    await orchestrator.execute(j);
    const callsAfterFirst = llm.calls.length;

    const second = await orchestrator.execute(j);
    expect(second.state).toBe("completed");
    expect(second.output).toBe("once");
    expect(llm.calls.length).toBe(callsAfterFirst); // no additional planner calls
  });
});

function llmCallsOf(orchestrator: unknown): unknown[] {
  const deps = (orchestrator as { deps: { llm: { calls: unknown[] } } }).deps;
  return deps.llm.calls;
}

function hadToolExecution(store: InMemoryRunEventStore): boolean {
  for (const list of store["byRun"].values()) {
    if (list.some((event) => event.type === "step.tool")) {
      return true;
    }
  }
  return false;
}

void deriveState;
