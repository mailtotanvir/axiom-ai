/**
 * Shared behavioral contract for prompt registry stores (O2). The same
 * suite runs against the in-memory store always and against the
 * Prisma/Postgres store when RUN_DB_TESTS=1 — keeping both honest.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryPromptRegistry } from "../src/prompts/memoryStore.js";
import {
  ImmutableVersion,
  NotPublished,
  PromotionOrderSkipped,
  SemverInvalid,
  VersionExists,
} from "../src/prompts/store.js";
import type { PromptRegistryStore } from "../src/prompts/types.js";

export function runRegistryBehavior(
  makeStore: () => PromptRegistryStore,
  /** Unique per suite so shared databases never see row collisions. */
  tenantPrefix = "t",
): void {
  describe("prompt registry behavior", () => {
    let store: PromptRegistryStore;
    const t1 = `${tenantPrefix}1`;
    const t2 = `${tenantPrefix}2`;

    beforeEach(() => {
      store = makeStore();
    });

    it("creates prompts scoped to tenants", async () => {
      await store.createPrompt({ tenantId: t1, name: "support-agent" });
      const duplicate = await store.createPrompt({ tenantId: t1, name: "support-agent" });
      await store.createPrompt({ tenantId: t2, name: "support-agent" });

      expect(duplicate.name).toBe("support-agent");
      expect(await store.listPrompts(t1)).toHaveLength(1);
      expect(await store.listPrompts(t2)).toHaveLength(1);
    });

    it("creates draft versions with unique semver per prompt", async () => {
      await store.createPrompt({ tenantId: t1, name: "summarizer" });
      await store.createVersion(t1, "summarizer", { semver: "0.1.0", template: "Sum: {{text}}" });
      await store.createVersion(t1, "summarizer", { semver: "0.2.0", template: "Sum2: {{text}}" });

      await expect(
        store.createVersion(t1, "summarizer", { semver: "0.1.0", template: "dup" }),
      ).rejects.toBeInstanceOf(VersionExists);
      await expect(
        store.createVersion(t1, "summarizer", { semver: "bad", template: "x" }),
      ).rejects.toBeInstanceOf(SemverInvalid);

      const versions = await store.listVersions(t1, "summarizer");
      expect(versions.map((version) => version.semver)).toEqual(["0.2.0", "0.1.0"]);
      expect(versions.every((version) => version.status === "draft")).toBe(true);
    });

    it("publishes idempotently; drafts cannot promote", async () => {
      await store.createPrompt({ tenantId: t1, name: "summarizer" });
      await store.createVersion(t1, "summarizer", { semver: "1.0.0", template: "v1" });
      await store.createVersion(t1, "summarizer", { semver: "1.1.0", template: "v2" });

      const published = await store.publish(t1, "summarizer", "1.0.0");
      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();

      // Idempotent re-publish is fine.
      await store.publish(t1, "summarizer", "1.0.0");

      // Draft versions cannot be promoted.
      await expect(
        store.promote(t1, "summarizer", "1.1.0", "development"),
      ).rejects.toBeInstanceOf(NotPublished);
    });

    it("archives block re-publication", async () => {
      await store.createPrompt({ tenantId: t1, name: "legacy" });
      await store.createVersion(t1, "legacy", { semver: "1.0.0", template: "old" });
      await store.publish(t1, "legacy", "1.0.0");
      await store.archive(t1, "legacy", "1.0.0");

      await expect(store.publish(t1, "legacy", "1.0.0")).rejects.toBeInstanceOf(
        ImmutableVersion,
      );
    });

    it("enforces ordered environment promotion", async () => {
      await store.createPrompt({ tenantId: t1, name: "classifier" });
      await store.createVersion(t1, "classifier", {
        semver: "2.0.0",
        template: "Classify {{input}}",
      });
      await store.publish(t1, "classifier", "2.0.0");

      // Skipping earlier environments fails.
      await expect(
        store.promote(t1, "classifier", "2.0.0", "production"),
      ).rejects.toBeInstanceOf(PromotionOrderSkipped);
      await expect(
        store.promote(t1, "classifier", "2.0.0", "staging"),
      ).rejects.toBeInstanceOf(PromotionOrderSkipped);

      await store.promote(t1, "classifier", "2.0.0", "development");
      await store.promote(t1, "classifier", "2.0.0", "staging");
      const prod = await store.promote(t1, "classifier", "2.0.0", "production");

      expect(prod.environments).toEqual(["development", "staging", "production"]);
    });

    it("lists only versions promoted to an environment when resolving latest", async () => {
      await store.createPrompt({ tenantId: t1, name: "extractor" });
      await store.createVersion(t1, "extractor", { semver: "1.0.0", template: "a {{x}}" });
      await store.createVersion(t1, "extractor", { semver: "1.1.0", template: "b {{x}}" });
      await store.publish(t1, "extractor", "1.0.0");
      await store.publish(t1, "extractor", "1.1.0");
      await store.promote(t1, "extractor", "1.1.0", "development");

      const versions = await store.listVersions(t1, "extractor");
      const promoted = versions.filter((version) => version.environments.includes("development"));
      expect(promoted.map((version) => version.semver)).toEqual(["1.1.0"]);
    });

    it("isolates tenants with identical prompt names", async () => {
      await store.createPrompt({ tenantId: t1, name: "shared-name" });
      await store.createPrompt({ tenantId: t2, name: "shared-name" });
      await store.createVersion(t1, "shared-name", { semver: "1.0.0", template: "t1 body" });

      await expect(store.listVersions(t2, "shared-name")).resolves.toEqual([]);
    });
  });
}

export function inMemoryRegistryFactory(): () => PromptRegistryStore {
  return () => new InMemoryPromptRegistry();
}
