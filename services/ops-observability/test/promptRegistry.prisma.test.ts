/**
 * Prisma/Postgres store runs the shared behavior suite when RUN_DB_TESTS=1
 * (requires the compose Postgres). Proves O2 against real storage.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateRegistry } from "../src/app.js";
import { PrismaPromptRegistry } from "../src/prompts/store.js";
import type { PromptRegistryStore } from "../src/prompts/types.js";
import { runRegistryBehavior } from "./promptRegistry.behavior.js";

const DB_URI =
  process.env.POSTGRES_DB_URI ?? "postgresql://axiom:axiom@localhost:5432/axiom_metadata";
const RUN = process.env.RUN_DB_TESTS === "1";

// Unique namespace per run keeps repeated executions independent.
const SUITE_PREFIX = `suite-${Date.now()}`;

describe.skipIf(!RUN)("PrismaPromptRegistry (live Postgres)", () => {
  let store: PromptRegistryStore;

  beforeAll(async () => {
    await migrateRegistry(DB_URI);
    store = new PrismaPromptRegistry(DB_URI);
  });

  afterAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    const cleanup = new PrismaClient({ datasourceUrl: DB_URI });
    try {
      await cleanup.prompt.deleteMany({ where: { tenantId: { startsWith: SUITE_PREFIX } } });
    } finally {
      await cleanup.$disconnect();
    }
  });

  it("connects and migrates", async () => {
    const probeTenant = `${SUITE_PREFIX}-probe`;
    await store.createPrompt({ tenantId: probeTenant, name: "connectivity-probe" });
    expect(await store.getPrompt(probeTenant, "connectivity-probe")).not.toBeNull();
  });

  describe("shared behavior", () => {
    runRegistryBehavior(
      () => new PrismaPromptRegistry(DB_URI),
      `${SUITE_PREFIX}-`,
    );
  });
});
