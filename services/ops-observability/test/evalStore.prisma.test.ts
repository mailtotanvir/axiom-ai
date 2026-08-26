/**
 * PrismaEvalStore runs against real Postgres when RUN_DB_TESTS=1
 * (compose Postgres). Proves the O3 storage path: dataset versioning,
 * run lifecycle, and latest-run gate lookups.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateRegistry } from "../src/app.js";
import { PrismaEvalStore } from "../src/evals/store.js";
import type { EvalResultRow } from "../src/evals/store.js";

const DB_URI =
  process.env.POSTGRES_DB_URI ?? "postgresql://axiom:axiom@localhost:5432/axiom_metadata";
const RUN = process.env.RUN_DB_TESTS === "1";

const SUITE_PREFIX = `eval-suite-${Date.now()}`;

describe.skipIf(!RUN)("PrismaEvalStore (live Postgres)", () => {
  let store: PrismaEvalStore;

  beforeAll(async () => {
    await migrateRegistry(DB_URI);
    store = new PrismaEvalStore(DB_URI);
  });

  afterAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    const cleanup = new PrismaClient({ datasourceUrl: DB_URI });
    try {
      await cleanup.goldenDataset.deleteMany({
        where: { tenantId: { startsWith: SUITE_PREFIX } },
      });
      await cleanup.evalRun.deleteMany({
        where: { tenantId: { startsWith: SUITE_PREFIX } },
      });
    } finally {
      await cleanup.$disconnect();
    }
  });

  it("creates successive dataset versions and reads them back", async () => {
    const tenant = `${SUITE_PREFIX}-acme`;
    const v1 = await store.createDataset({
      tenantId: tenant,
      name: "golden",
      cases: [{ externalId: "c1", vars: { q: "hi" }, expected: { contains: "hello" } }],
    });
    expect(v1).toEqual({ name: "golden", version: 1, caseCount: 1 });

    const v2 = await store.createDataset({
      tenantId: tenant,
      name: "golden",
      cases: [
        { externalId: "c1", vars: { q: "hi" }, expected: { contains: "hello" } },
        { externalId: "c2", vars: { q: "bye" }, expected: { outputText: "goodbye" } },
      ],
    });
    expect(v2.version).toBe(2);

    // Latest by default; explicit older version still readable.
    const latest = await store.getDataset(tenant, "golden");
    expect(latest?.version).toBe(2);
    expect(latest?.cases.map((testCase) => testCase.externalId)).toEqual(["c1", "c2"]);
    const pinned = await store.getDataset(tenant, "golden", 1);
    expect(pinned?.cases).toHaveLength(1);
    expect(await store.getDataset(tenant, "missing")).toBeNull();
    // Tenant scoping: another tenant cannot see the dataset.
    expect(await store.getDataset(`${SUITE_PREFIX}-other`, "golden")).toBeNull();
  });

  it("tracks a run from start to finish and serves gate lookups", async () => {
    const tenant = `${SUITE_PREFIX}-acme`;
    await store.createDataset({
      tenantId: tenant,
      name: "gate-golden",
      cases: [{ externalId: "c1", vars: {}, expected: {} }],
    });
    const runId = await store.startRun({
      tenantId: tenant,
      datasetName: "gate-golden",
      datasetVersion: 1,
      promptName: "agent",
      promptVersion: "1.0.0",
      model: "openai/gpt-oss-120b",
    });

    // Running runs are invisible to the completed-only gate lookup.
    expect(
      await store.latestRun({ tenantId: tenant, datasetName: "gate-golden", promptName: "agent" }),
    ).toBeNull();

    const rows: EvalResultRow[] = [
      {
        timestamp: new Date().toISOString().replace("T", " ").replace("Z", ""),
        runId,
        tenantId: tenant,
        datasetName: "gate-golden",
        datasetVersion: 1,
        promptName: "agent",
        promptVersion: "1.0.0",
        model: "openai/gpt-oss-120b",
        caseId: "c1",
        metric: "contains",
        score: 1,
        passed: true,
      },
    ];
    // Postgres store is a no-op for rows (ClickHouse owns them); must not throw.
    await store.writeResults(rows);
    await store.finishRun(runId, {
      status: "completed",
      overallScore: 1,
      caseCount: 1,
      errorCount: 0,
    });

    const latest = await store.latestRun({
      tenantId: tenant,
      datasetName: "gate-golden",
      promptName: "agent",
    });
    expect(latest?.runId).toBe(runId);
    expect(latest?.status).toBe("completed");
    expect(latest?.overallScore).toBe(1);
    expect(latest?.startedAt).toBeInstanceOf(Date);
  });

  it("failed runs never satisfy the gate lookup", async () => {
    const tenant = `${SUITE_PREFIX}-acme`;
    const runId = await store.startRun({
      tenantId: tenant,
      datasetName: "fail-golden",
      datasetVersion: 1,
      promptName: "agent-fail",
      promptVersion: "1.0.0",
      model: "openai/gpt-oss-120b",
    });
    await store.finishRun(runId, {
      status: "failed",
      overallScore: 0,
      caseCount: 1,
      errorCount: 1,
    });
    expect(
      await store.latestRun({ tenantId: tenant, datasetName: "fail-golden", promptName: "agent-fail" }),
    ).toBeNull();
  });
});
