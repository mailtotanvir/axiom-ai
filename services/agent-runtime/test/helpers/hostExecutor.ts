import type { SandboxExecution, SandboxExecutor } from "../src/sandbox/types.js";

/**
 * Test-only executor that evaluates tool sources on the host. Orchestrator
 * and registry tests care about plumbing, not isolation — the real
 * isolated-vm guarantees are covered exclusively by sandbox.test.ts.
 */
export function hostExecutor(): SandboxExecutor {
  return {
    name: "host-test-executor",
    async execute(execution: SandboxExecution) {
      const { manifest, argsJson } = execution;
      try {
        const factory = new Function(
          `${manifest.source}\nreturn typeof tool === "function" ? tool(JSON.parse(${JSON.stringify(argsJson)})) : null;`,
        );
        const result = factory();
        if (
          result !== null &&
          typeof result === "object" &&
          "__sandboxError" in (result as Record<string, unknown>)
        ) {
          return { ok: false, payload: JSON.stringify(result), kind: "runtime" as const };
        }
        return { ok: true, payload: JSON.stringify(result ?? null) };
      } catch (error) {
        return {
          ok: false,
          payload: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          kind: "runtime" as const,
        };
      }
    },
  };
}
