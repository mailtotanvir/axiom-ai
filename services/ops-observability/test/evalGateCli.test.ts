/**
 * Gate CLI (O3): argument handling and exit-code contract against a
 * scripted ops-plane response.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runGate } from "../src/evals/gateCli.js";

describe("axiom-eval-gate CLI", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const minScore = url.searchParams.get("minScore") ?? "1";
      const passed = Number(minScore) <= 0.9;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          passed
            ? { passed: true, score: 0.95, requiredMinScore: 0.9, runId: "run-7" }
            : { passed: false, score: 0.4, requiredMinScore: 0.95, reason: "score below threshold" },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no listen address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exits 2 with usage when required args are missing", async () => {
    const result = await runGate(["--tenant", "acme"]);
    expect(result.code).toBe(2);
    expect(result.message).toContain("usage:");
  });

  it("exits 0 on a passing gate", async () => {
    const result = await runGate([
      "--ops-url",
      baseUrl,
      "--tenant",
      "acme",
      "--dataset",
      "golden",
      "--prompt",
      "agent",
      "--min-score",
      "0.9",
    ]);
    expect(result.code).toBe(0);
    expect(result.message).toContain("GATE PASSED");
    expect(result.message).toContain("run-7");
  });

  it("exits 1 on a failing gate with the failure reason", async () => {
    const result = await runGate([
      "--ops-url",
      baseUrl,
      "--tenant",
      "acme",
      "--dataset",
      "golden",
      "--prompt",
      "agent",
      "--min-score",
      "0.99",
    ]);
    expect(result.code).toBe(1);
    expect(result.message).toContain("GATE FAILED");
  });

  it("exits 2 when the ops plane is unreachable", async () => {
    const result = await runGate([
      "--ops-url",
      "http://127.0.0.1:1",
      "--tenant",
      "acme",
      "--dataset",
      "golden",
      "--prompt",
      "agent",
    ]);
    expect(result.code).toBe(2);
    expect(result.message).toContain("unreachable");
  });
});
