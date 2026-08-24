/**
 * Postgres-backed API key store (G3). Schema is created idempotently on
 * boot; keys are stored hashed and never logged.
 */

import { Pool, type PoolClient } from "pg";

import type { TenantContext } from "@axiom-ai/core";

import {
  generateApiKey,
  hashApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
  type IssuedApiKey,
} from "./apiKeyStore.js";

export class PostgresApiKeyStore implements ApiKeyStore {
  private readonly pool: Pool;
  private migrated = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async migrate(client?: PoolClient): Promise<void> {
    const run = async (c: PoolClient): Promise<void> => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS gateway_api_keys (
          key_hash        TEXT PRIMARY KEY,
          tenant_id       TEXT NOT NULL,
          project_id      TEXT NOT NULL,
          allowed_models  TEXT[] NOT NULL DEFAULT '{}',
          rate_limit_tier TEXT NOT NULL CHECK (rate_limit_tier IN ('free','pro','enterprise')),
          active          BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    };
    if (client !== undefined) {
      await run(client);
    } else {
      await this.withClient(run);
    }
    this.migrated = true;
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async issue(input: Parameters<ApiKeyStore["issue"]>[0]): Promise<IssuedApiKey> {
    if (!this.migrated) {
      await this.migrate();
    }
    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    await this.withClient((c) =>
      c.query(
        `INSERT INTO gateway_api_keys
           (key_hash, tenant_id, project_id, allowed_models, rate_limit_tier)
         VALUES ($1, $2, $3, $4::text[], $5)`,
        [
          keyHash,
          input.tenantId,
          input.projectId,
          input.allowedModels ?? [],
          input.rateLimitTier,
        ],
      ),
    );
    return {
      apiKey,
      record: {
        keyHash,
        tenantId: input.tenantId,
        projectId: input.projectId,
        allowedModels: input.allowedModels ?? [],
        rateLimitTier: input.rateLimitTier,
        active: true,
        createdAt: new Date(),
      },
    };
  }

  async lookup(presentedKey: string): Promise<ApiKeyRecord | undefined> {
    if (this.migrated === false) {
      // Keys cannot exist before migration; avoids DB round-trips on garbage.
      return undefined;
    }
    const result = await this.withClient((c) =>
      c.query(
        `SELECT key_hash, tenant_id, project_id, allowed_models, rate_limit_tier, active, created_at
         FROM gateway_api_keys WHERE key_hash = $1`,
        [hashApiKey(presentedKey)],
      ),
    );
    const row = result.rows[0];
    if (row === undefined || row.active !== true) {
      return undefined;
    }
    return {
      keyHash: String(row.key_hash),
      tenantId: String(row.tenant_id),
      projectId: String(row.project_id),
      allowedModels: (row.allowed_models as string[]) ?? [],
      rateLimitTier: row.rate_limit_tier as TenantContext["rateLimitTier"],
      active: true,
      createdAt: new Date(row.created_at as string),
    };
  }

  async revoke(keyHash: string): Promise<boolean> {
    const result = await this.withClient((c) =>
      c.query(`DELETE FROM gateway_api_keys WHERE key_hash = $1`, [keyHash]),
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
