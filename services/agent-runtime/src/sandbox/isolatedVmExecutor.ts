/**
 * isolated-vm executor (A3, ADR: sandbox decision).
 *
 * One fresh Isolate per execution — no shared heap, no host handles, no
 * module loader inside the guest. Enforced caps:
 *   - memory: `Isolate({ memoryLimit })` → heap bombs abort the isolate
 *   - CPU:    `context.eval(code, { timeout })` → infinite loops die
 *   - bridge: args enter as a JSON string; results leave as a JSON string
 *
 * Any guest failure is returned as a structured result (fail closed), and
 * the isolate is disposed regardless of outcome.
 */

import ivm from "isolated-vm";
import { globalMetrics, type Counter } from "@tanvir1971/core";

import type { SandboxExecution, SandboxExecutor } from "./types.js";
import type { ToolExecutionResult } from "../agents/types.js";

const sandboxRejections: Counter = globalMetrics.registerCounter(
  "agent_runtime_sandbox_rejections_total",
  "Total number of tool sandbox rejections by reason",
);

const WRAP_PREFIX = "const __input = ";
const HARNESS_SUFFIX = `
;(function () {
  if (typeof tool !== "function") {
    return JSON.stringify({ __sandboxError: "manifest must define function tool(input)" });
  }
  try {
    const __result = tool(__input);
    return JSON.stringify(__result === undefined ? null : __result);
  } catch (err) {
    return JSON.stringify({ __sandboxError: String((err && err.message) || err) });
  }
})()
`;

function classify(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  // Memory check first: ivm reports heap exhaustion as
  // "Isolate was disposed during execution due to memory limit".
  if (/memory|out of memory/i.test(message)) {
    return {
      ok: false,
      payload: JSON.stringify({ error: "tool exceeded its memory limit" }),
      kind: "memory",
    };
  }
  if (/timed out|disposed/i.test(message)) {
    return { ok: false, payload: JSON.stringify({ error: "tool execution timed out" }), kind: "timeout" };
  }
  return { ok: false, payload: JSON.stringify({ error: `tool runtime error: ${message}` }), kind: "runtime" };
}

export class IsolatedVmExecutor implements SandboxExecutor {
  readonly name = "isolated-vm";

  async execute(execution: SandboxExecution): Promise<ToolExecutionResult> {
    const { manifest, argsJson } = execution;
    let isolate: ivm.Isolate | undefined;
    try {
      isolate = new ivm.Isolate({ memoryLimit: manifest.memoryMb });
      const context = await isolate.createContext();

      const script = `${WRAP_PREFIX}${argsJson};\n${manifest.source}\n${HARNESS_SUFFIX}`;
      const result = await context.eval(script, { timeout: manifest.timeoutMs });

      if (typeof result !== "string") {
        return { ok: false, payload: JSON.stringify({ error: "tool returned a non-serializable value" }), kind: "runtime" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        return { ok: false, payload: JSON.stringify({ error: "tool returned non-JSON output" }), kind: "runtime" };
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "__sandboxError" in (parsed as Record<string, unknown>)
      ) {
        return {
          ok: false,
          payload: result,
          kind: "runtime",
        };
      }
      return { ok: true, payload: result };
    } catch (error) {
      const outcome = classify(error);
      sandboxRejections.inc({ reason: outcome.kind ?? "runtime" });
      return outcome;
    } finally {
      // Memory-exhausted isolates self-dispose.
      if (isolate !== undefined && !isolate.isDisposed) {
        isolate.dispose();
      }
    }
  }
}
