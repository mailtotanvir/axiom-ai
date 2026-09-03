/**
 * Tool registry (A3): manifest validation, argument/result size caps, and
 * execution through the configured sandbox. Fail-closed: any validation or
 * executor absence produces a structured error, never a host-side throw.
 */

import { createHash } from "node:crypto";

import type { ToolExecutionResult, ToolManifest } from "../agents/types.js";
import { AxiomError } from "@tanvir1971/core";

import type { SandboxExecutor } from "./types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_SOURCE_BYTES = 65_536;
const MAX_ARGS_BYTES = 262_144;
const MAX_RESULT_BYTES = 262_144;

export interface RegisteredTool {
  readonly manifest: ToolManifest;
  /** Stable content hash; changes invalidate cached decisions. */
  readonly sourceHash: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly executor: SandboxExecutor) {}

  register(manifest: ToolManifest): RegisteredTool {
    validateManifest(manifest);
    const registered: RegisteredTool = {
      manifest,
      sourceHash: createHash("sha256").update(manifest.source).digest("hex"),
    };
    this.tools.set(manifest.name, registered);
    return registered;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Rendered tool docs for the context assembler. */
  describe(names?: readonly string[]): string {
    const selected =
      names === undefined ? [...this.tools.values()] : names.map((n) => this.tools.get(n)).filter((t): t is RegisteredTool => t !== undefined);
    if (selected.length === 0) {
      return "";
    }
    return [
      "Available tools (call by emitting a tool_call decision):",
      ...selected.map(
        (tool) =>
          `- ${tool.manifest.name}: ${tool.manifest.description ?? "no description"}`,
      ),
      "",
      'Decision format: {"type":"tool_call","tool":"<name>","arguments":{...}}',
      'Final answer format: {"type":"final","text":"..."}',
    ].join("\n");
  }

  async execute(name: string, args: unknown): Promise<ToolExecutionResult> {
    const registered = this.tools.get(name);
    if (registered === undefined) {
      return { ok: false, payload: JSON.stringify({ error: `unknown tool '${name}'` }), kind: "validation" };
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args ?? {});
    } catch {
      return { ok: false, payload: JSON.stringify({ error: "arguments are not JSON-serializable" }), kind: "validation" };
    }
    if (Buffer.byteLength(argsJson, "utf8") > MAX_ARGS_BYTES) {
      return { ok: false, payload: JSON.stringify({ error: "arguments exceed size cap" }), kind: "validation" };
    }

    const result = await this.executor.execute({ manifest: registered.manifest, argsJson });
    if (result.ok && Buffer.byteLength(result.payload, "utf8") > MAX_RESULT_BYTES) {
      return { ok: false, payload: JSON.stringify({ error: "result exceeds size cap" }), kind: "validation" };
    }
    return result;
  }
}

function validation(message: string): AxiomError {
  return new AxiomError("AXIOM_VALIDATION_FAILED", message);
}

function validateManifest(manifest: ToolManifest): void {
  if (!NAME_PATTERN.test(manifest.name)) {
    throw validation(`invalid tool name '${manifest.name}'`);
  }
  if (Buffer.byteLength(manifest.source, "utf8") > MAX_SOURCE_BYTES) {
    throw validation("tool source exceeds 64KB cap");
  }
  if (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 10 || manifest.timeoutMs > 60_000) {
    throw validation("timeoutMs must be between 10 and 60000");
  }
  if (!Number.isInteger(manifest.memoryMb) || manifest.memoryMb < 8 || manifest.memoryMb > 512) {
    throw validation("memoryMb must be between 8 and 512");
  }
}
