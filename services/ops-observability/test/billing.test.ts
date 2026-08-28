import { describe, expect, it } from "vitest";

import {
  BillingSync,
  billingEnabled,
  parseTenantMappings,
  type BillingStore,
  type StripeMeteredClient,
} from "../src/billing/billing.js";
import { buildApp } from "../src/app.js";
import { createOpsConfig } from "../src/config.js";

function memoryUsageStore(usage: Record<string, number>): BillingStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async tenantUsage(tenantId: string) {
      reads.push(tenantId);
      return usage[tenantId] ?? 0;
    },
  };
}

function fakeStripe(records: Array<{ item: string; quantity: number }>): StripeMeteredClient {
  return {
    async createUsageRecord(subscriptionItemId, record) {
      records.push({ item: subscriptionItemId, quantity: record.quantity });
      return { id: `ur_${records.length}` };
    },
    async retrieveUpcomingInvoice() {
      return {
        total: 4200,
        currency: "usd",
        lines: [{ description: "Token usage (test)", amount: 4200 }],
      };
    },
  };
}

describe("billingEnabled", () => {
  it("is off by default and requires a stripe key", () => {
    expect(billingEnabled({})).toBe(false);
    expect(billingEnabled({ AXIOM_BILLING_ENABLED: "true" })).toBe(false);
    expect(billingEnabled({ AXIOM_BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(true);
    expect(billingEnabled({ AXIOM_BILLING_ENABLED: "false", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
  });
});

describe("parseTenantMappings", () => {
  it("parses tenant=subscription-item pairs", () => {
    const mappings = parseTenantMappings("t-1=si_abc, t-2=si_def");
    expect(mappings).toEqual([
      { tenantId: "t-1", subscriptionItemId: "si_abc" },
      { tenantId: "t-2", subscriptionItemId: "si_def" },
    ]);
  });

  it("ignores malformed entries", () => {
    expect(parseTenantMappings("broken,,t-1=si_ok")).toEqual([
      { tenantId: "t-1", subscriptionItemId: "si_ok" },
    ]);
  });
});

describe("BillingSync.syncUsage", () => {
  it("pushes usage for mapped tenants with idempotency keys", async () => {
    const store = memoryUsageStore({ "t-1": 15_000, "t-2": 0 });
    const records: Array<{ item: string; quantity: number }> = [];
    const sync = new BillingSync(store, fakeStripe(records), [
      { tenantId: "t-1", subscriptionItemId: "si_a" },
      { tenantId: "t-2", subscriptionItemId: "si_b" },
    ]);
    const period = Date.now();
    const results = await sync.syncUsage(period);
    expect(records).toEqual([{ item: "si_a", quantity: 15_000 }]);
    expect(results).toEqual([
      { tenantId: "t-1", quantity: 15_000, recordId: "ur_1" },
      { tenantId: "t-2", quantity: 0, skipped: "no-usage" },
    ]);
  });
});

describe("billing routes", () => {
  const baseEnv = {
    AXIOM_ENV: "test" as const,
    AXIOM_INTER_SERVICE_SECRET: "test-secret",
    AXIOM_BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  };

  function makeSync(): BillingSync {
    return new BillingSync(memoryUsageStore({ "t-1": 500 }), fakeStripe([]), [
      { tenantId: "t-1", subscriptionItemId: "si_a" },
    ]);
  }

  it("registers routes when billing is enabled", async () => {
    const config = { ...createOpsConfig(baseEnv), AXIOM_BILLING_ENABLED: "true" as const };
    const app = buildApp(config, { billingSync: makeSync() });
    const injected = await app.inject({
      method: "POST",
      url: "/v1/billing/sync-usage",
      headers: { "x-axiom-internal-secret": "test-secret" },
      payload: {},
    });
    expect(injected.statusCode).toBe(200);
    const body = injected.json() as { synced: number };
    expect(body.synced).toBe(1);
    await app.close();
  });

  it("rejects calls without the admin secret", async () => {
    const config = { ...createOpsConfig(baseEnv), AXIOM_BILLING_ENABLED: "true" as const };
    const app = buildApp(config, { billingSync: makeSync() });
    const injected = await app.inject({ method: "POST", url: "/v1/billing/sync-usage", payload: {} });
    expect(injected.statusCode).toBe(403);
    await app.close();
  });

  it("serves invoice preview with the admin secret", async () => {
    const config = { ...createOpsConfig(baseEnv), AXIOM_BILLING_ENABLED: "true" as const };
    const app = buildApp(config, { billingSync: makeSync() });
    const injected = await app.inject({
      method: "GET",
      url: "/v1/billing/invoice-preview?subscription=sub_123",
      headers: { "x-axiom-internal-secret": "test-secret" },
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.json()).toMatchObject({ total: 4200, currency: "usd" });
    await app.close();
  });

  it("omits billing routes entirely when the flag is off", async () => {
    const config = { ...createOpsConfig(baseEnv), AXIOM_BILLING_ENABLED: "false" as const };
    const app = buildApp(config, { billingSync: makeSync() });
    const injected = await app.inject({ method: "POST", url: "/v1/billing/sync-usage", payload: {} });
    expect(injected.statusCode).toBe(404);
    await app.close();
  });
});
