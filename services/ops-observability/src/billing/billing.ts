/**
 * Milestone 5.4 (X9): developer-mode billing.
 *
 * Syncs per-tenant token usage from ClickHouse metering to Stripe Metered
 * Billing (TEST keys only) and exposes an invoice preview endpoint.
 * Everything is gated behind AXIOM_BILLING_ENABLED=true; the module is inert
 * (and the routes absent) when the flag is off or no Stripe key is present.
 *
 * The Stripe client is injected as a minimal interface so tests run without
 * the network and the dependency stays optional.
 */

export interface UsageRecord {
  tenantId: string;
  /** Metered usage quantity for the period (tokens). */
  quantity: number;
  /** Usage timestamp (ms epoch). */
  timestamp: number;
  /** Idempotency key so replays never double-bill. */
  idempotencyKey: string;
}

/** Minimal Stripe metered-billing surface (test-mode). */
export interface StripeMeteredClient {
  createUsageRecord(
    subscriptionItemId: string,
    record: { quantity: number; timestamp: number; action?: "increment" | "set" },
    options?: { idempotencyKey?: string },
  ): Promise<{ id: string }>;
  retrieveUpcomingInvoice(params: {
    subscription: string;
  }): Promise<{ total: number; currency: string; lines: Array<{ description?: string; amount: number }> }>;
}

export interface BillingStore {
  /** Aggregate token usage for a tenant in a period, from ClickHouse metering. */
  tenantUsage(tenantId: string, sinceMs: number): Promise<number>;
}

export interface BillingConfig {
  /** Master flag; billing stays disabled unless explicitly true. */
  AXIOM_BILLING_ENABLED?: string | boolean;
  STRIPE_SECRET_KEY?: string;
  /** Maps tenant id -> Stripe subscription item (test-mode fixture). */
  STRIPE_TENANT_SUBSCRIPTION_ITEMS?: string;
}

export interface TenantMapping {
  tenantId: string;
  subscriptionItemId: string;
}

export function parseTenantMappings(raw?: string): TenantMapping[] {
  if (!raw) return [];
  const mappings: TenantMapping[] = [];
  for (const pair of raw.split(",")) {
    const [tenantId, subscriptionItemId] = pair.split("=").map((part) => part?.trim());
    if (tenantId && subscriptionItemId) {
      mappings.push({ tenantId, subscriptionItemId });
    }
  }
  return mappings;
}

export function billingEnabled(config: BillingConfig): boolean {
  const flag = config.AXIOM_BILLING_ENABLED;
  if (flag !== true && flag !== "true") return false;
  return Boolean(config.STRIPE_SECRET_KEY);
}

export class BillingSync {
  constructor(
    private readonly store: BillingStore,
    private readonly stripe: StripeMeteredClient,
    private readonly mappings: TenantMapping[],
  ) {}

  /**
   * Pushes unreported usage for every mapped tenant. Idempotent per
   * idempotency key: `period` anchors the key so a re-run for the same
   * period is a no-op on the Stripe side.
   */
  async syncUsage(periodMs: number): Promise<Array<{ tenantId: string; quantity: number; recordId?: string; skipped?: string }>> {
    const results: Array<{ tenantId: string; quantity: number; recordId?: string; skipped?: string }> = [];
    for (const mapping of this.mappings) {
      const since = periodMs - USAGE_WINDOW_MS;
      const quantity = await this.store.tenantUsage(mapping.tenantId, since);
      if (quantity <= 0) {
        results.push({ tenantId: mapping.tenantId, quantity, skipped: "no-usage" });
        continue;
      }
      const record = await this.stripe.createUsageRecord(
        mapping.subscriptionItemId,
        { quantity, timestamp: Math.floor(periodMs / 1000), action: "set" },
        { idempotencyKey: `axiom-${mapping.tenantId}-${periodMs}` },
      );
      results.push({ tenantId: mapping.tenantId, quantity, recordId: record.id });
    }
    return results;
  }

  async invoicePreview(subscriptionId: string): Promise<{
    total: number;
    currency: string;
    lines: Array<{ description?: string; amount: number }>;
  }> {
    const invoice = await this.stripe.retrieveUpcomingInvoice({ subscription: subscriptionId });
    return {
      total: invoice.total,
      currency: invoice.currency,
      lines: invoice.lines.map((line) => ({ description: line.description, amount: line.amount })),
    };
  }
}

/** Sync window: aggregate the trailing 24 hours of metered usage. */
export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
