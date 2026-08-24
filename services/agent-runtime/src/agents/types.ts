/**
 * Agent domain types (Phase 3, epics A1–A3).
 *
 * The wire contract between services lives in proto/axiom/v1/agent.proto;
 * these are the in-process shapes the runtime operates on.
 */

export interface ToolManifest {
  /** Identifier used in agent definitions and tool_call decisions. */
  name: string;
  description?: string;
  /** JavaScript source defining `function tool(input) { … }`. */
  source: string;
  timeoutMs: number;
  memoryMb: number;
}

export interface ToolExecutionResult {
  ok: boolean;
  /** JSON-encoded result (ok) or error description (!ok). */
  payload: string;
  kind?: "timeout" | "memory" | "runtime" | "validation";
}

export interface AgentDefinition {
  model: string;
  systemPrompt?: string;
  /** Registered tool manifest names available to this agent. */
  tools?: string[];
  maxSteps: number;
  maxTotalTokens: number;
  /** When true, the first tool call pauses the run pending approval. */
  requiresApproval?: boolean;
}

export interface AgentRunJob {
  runId: string;
  tenantId: string;
  projectId: string;
  /** Caller-supplied dedup key; duplicate submissions map to one run. */
  idempotencyKey: string;
  input: {
    messages: Array<{ role: "system" | "user"; content: string }>;
  };
  definition: AgentDefinition;
  /** Set when resuming an approval-gated run. */
  approval?: { grantedBy: string };
}

export type RunEventType =
  | "run.started"
  | "step.llm"
  | "step.tool"
  | "approval.requested"
  | "approval.granted"
  | "run.completed"
  | "run.failed";

export interface RunEvent<T = unknown> {
  seq: number;
  runId: string;
  type: RunEventType;
  at: string;
  data: T;
}

export type RunState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed";

export interface RunStatus {
  runId: string;
  state: RunState;
  steps: number;
  tokensUsed: number;
  failureReason?: string;
  output?: string;
}
