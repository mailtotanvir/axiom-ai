/**
 * Sandbox red-team suite (A3 exit gate). Every attack must fail CLOSED:
 * the guest is stopped by enforced caps or missing capabilities, and the
 * host process stays healthy.
 */

import { describe, expect, it } from "vitest";

import type { ToolManifest } from "../src/agents/types.js";
import { IsolatedVmExecutor } from "../src/sandbox/isolatedVmExecutor.js";
import { ToolRegistry } from "../src/sandbox/registry.js";

const executor = new IsolatedVmExecutor();

function manifest(source: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: "attack",
    source,
    timeoutMs: 1_000,
    memoryMb: 64,
    ...overrides,
  };
}

describe("isolated-vm sandbox (red team)", () => {
  it("runs a legitimate tool end to end", async () => {
    const result = await executor.execute({
      manifest: manifest(`
        function tool(input) {
          const numbers = input.numbers;
          if (!Array.isArray(numbers)) throw new Error("numbers required");
          const total = numbers.reduce((a, b) => a + b, 0);
          return { sum: total };
        }
      `),
      argsJson: JSON.stringify({ numbers: [1, 2, 3, 4] }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.payload)).toEqual({ sum: 10 });
  });

  it("stops infinite loops via the CPU-time cap", async () => {
    const start = Date.now();
    const result = await executor.execute({
      manifest: manifest(`function tool() { while (true) {} }`),
      argsJson: "{}",
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("timeout");
    // Cap is 1000ms; generous ceiling proves the host was never blocked long.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it("stops heap bombs via the memory cap", async () => {
    const result = await executor.execute({
      manifest: manifest(
        `function tool() { const chunks = []; while (true) { chunks.push(new Array(1e6).fill("bomb")); } }`,
        { memoryMb: 32 },
      ),
      argsJson: "{}",
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("memory");
  }, 15_000);

  it("denies module loading (fs escape attempt)", async () => {
    const result = await executor.execute({
      manifest: manifest(`
        function tool() {
          const fs = require("fs");
          return fs.readFileSync("/etc/passwd", "utf8").slice(0, 20);
        }
      `),
      argsJson: "{}",
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("runtime");
    expect(result.payload).not.toContain("root");
  });

  it("denies network egress attempts", async () => {
    const result = await executor.execute({
      manifest: manifest(`
        function tool() {
          return fetch("http://169.254.169.254/latest/meta-data/");
        }
      `),
      argsJson: "{}",
    });

    expect(result.ok).toBe(false);
  });

  it("hides host runtime handles (process/global escape)", async () => {
    const result = await executor.execute({
      manifest: manifest(`
        function tool() {
          return {
            hasProcess: typeof process !== "undefined",
            hasGlobal: typeof global !== "undefined",
            hasRequire: typeof require !== "undefined",
            hasFetch: typeof fetch !== "undefined",
            hasCwd: typeof cwd !== "undefined",
          };
        }
      `),
      argsJson: "{}",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.payload)).toEqual({
      hasProcess: false,
      hasGlobal: false,
      hasRequire: false,
      hasFetch: false,
      hasCwd: false,
    });
  });

  it("contains prototype pollution inside the isolate", async () => {
    const pollution = await executor.execute({
      manifest: manifest(`
        function tool() {
          Object.prototype.polluted = "pwned";
          return "done";
        }
      `),
      argsJson: "{}",
    });
    expect(pollution.ok).toBe(true);

    // The host Object prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // A fresh isolate does not observe the pollution either.
    const check = await executor.execute({
      manifest: manifest(`function tool() { return { polluted: ({}).polluted ?? null }; }`),
      argsJson: "{}",
    });
    expect(JSON.parse(check.payload)).toEqual({ polluted: null });
  });

  it("rejects manifests that do not define a tool function", async () => {
    const result = await executor.execute({
      manifest: manifest(`const x = 1;`),
      argsJson: "{}",
    });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.payload).__sandboxError).toContain("tool(input)");
  });
});

describe("ToolRegistry validation (fail closed)", () => {
  const registry = new ToolRegistry(executor);

  it("rejects invalid manifests at registration", () => {
    expect(() =>
      registry.register(manifest("x", { name: "Bad Name" })),
    ).toThrowError(/invalid tool name/i);
    expect(() =>
      registry.register({ ...manifest("x"), timeoutMs: 0 }),
    ).toThrowError(/timeoutMs/i);
    expect(() =>
      registry.register({ ...manifest("x".repeat(70_000)) }),
    ).toThrowError(/64KB/i);
  });

  it("returns structured errors for unknown tools and oversized payloads", async () => {
    const unknown = await registry.execute("nonexistent", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.kind).toBe("validation");

    registry.register(manifest(`function tool() { return "x".repeat(300_000); }`, { name: "flood" }));
    const flood = await registry.execute("flood", {});
    expect(flood.ok).toBe(false);
    expect(flood.kind).toBe("validation");
    expect(flood.payload).toContain("size cap");
  });
});
