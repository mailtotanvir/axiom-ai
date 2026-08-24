/**
 * Tool sandbox contract (A3). Tools are untrusted JavaScript executed in
 * an isolated V8 isolate with CPU-time and heap caps. The host bridge is
 * JSON-in/JSON-out only — no handles, no require, no network.
 */

import type { ToolExecutionResult, ToolManifest } from "../agents/types.js";

export interface SandboxExecution {
  manifest: ToolManifest;
  /** JSON-encoded arguments passed to `tool(input)`. */
  argsJson: string;
}

export interface SandboxExecutor {
  readonly name: string;
  execute(execution: SandboxExecution): Promise<ToolExecutionResult>;
}
