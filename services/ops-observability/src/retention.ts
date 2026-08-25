/**
 * Per-tenant trace retention policies (O1). The collector enforces the
 * global TTL baseline at ingestion; these policies clamp how far back each
 * tenant's traces may be searched in the ops plane.
 */

import { Pool, type PoolClient } from "pg";

const DDL = [
  `CREATE SCHEMA IF NOT EXISTS axiom_ops`,
  `CREATE TABLE IF NOT EXISTS axiom_ops.trace_retention_policies (
     tenant_id   text PRIMARY KEY,
     retain_days integer NOT NULL CHECK (retain_days BETWEEN 1 AND 3650),
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
];

export interface RetentionPolicy {
  tenantId: string;
  retainDays: number;
  updatedAt: string;
}

export interface RetentionStore {
  set(tenantId: string, retainDays: number): Promise<RetentionPolicy>;
  get(tenantId: string): Promise<number | null>;
  list(): Promise<RetentionPolicy[]>;
  close(): Promise<void>;
}

export class PostgresRetentionStore implements RetentionStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    void this.migrate();
  }

  private async migrate(client?: PoolClient): Promise<void> {
    const c = client ?? (await this.pool.connect());
    try {
      for (const statement of DDL) {
        await c.query(statement);
      }
    } finally {
      if (client === undefined) {
        c.release();
      }
    }
  }

  async set(tenantId: string, retainDays: number): Promise<RetentionPolicy> {
    await this.migrate();
    const result = await this.pool.query<RetentionPolicy>(
      `INSERT INTO axiom_ops.trace_retention_policies (tenant_id, retain_days)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET retain_days = $2, updated_at = now()
       RETURNING tenant_id AS "tenantId", retain_days AS "retainDays", updated_at AS "updatedAt"`,
      [tenantId, retainDays],
    );
    return result.rows[0]!;
  }

  async get(tenantId: string): Promise<number | null> {
    await this.migrate();
    const result = await this.pool.query<{ retainDays: number }>(
      "SELECT retain_days AS \"retainDays\" FROM axiom_ops.trace_retention_policies WHERE tenant_id = $1",
      [tenantId],
    );
    return result.rows[0]?.retainDays ?? null;
  }

  async list(): Promise<RetentionPolicy[]> {
    await this.migrate();
    const result = await this.pool.query<RetentionPolicy>(
      'SELECT tenant_id AS "tenantId", retain_days AS "retainDays", updated_at AS "updatedAt" FROM axiom_ops.trace_retention_policies ORDER BY tenant_id',
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** In-memory store for tests and dev without Postgres. */
export class InMemoryRetentionStore implements RetentionStore {
  private readonly policies = new Map<string, RetentionPolicy>();

  async set(tenantId: string, retainDays: number): Promise<RetentionPolicy> {
    const policy: RetentionPolicy = {
      tenantId,
      retainDays,
      updatedAt: new Date().toISOString(),
    };
    this.policies.set(tenantId, policy);
    return policy;
  }

  async get(tenantId: string): Promise<number | null> {
    return this.policies.get(tenantId)?.retainDays ?? null;
  }

  async list(): Promise<RetentionPolicy[]> {
    return [...this.policies.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
