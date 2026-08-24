/**
 * API key storage (G3). Keys are presented as `ax_<base64url>` secrets and
 * stored only as SHA-256 hashes; lookups hash the presented key. Two
 * implementations: in-memory (tests/dev) and Postgres (production path).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { TenantContext } from "@axiom-ai/core";

export interface ApiKeyRecord extends TenantContext {
  keyHash: string;
  active: boolean;
  createdAt: Date;
}

export const API_KEY_PREFIX = "ax_";

export function hashApiKey(presentedKey: string): string {
  return createHash("sha256").update(presentedKey).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export interface IssuedApiKey {
  /** Plaintext key — returned exactly once at issuance. */
  apiKey: string;
  record: Omit<ApiKeyRecord, "createdAt"> & { createdAt: Date };
}

export interface ApiKeyStore {
  issue(input: {
    tenantId: string;
    projectId: string;
    allowedModels?: readonly string[];
    rateLimitTier: TenantContext["rateLimitTier"];
  }): Promise<IssuedApiKey>;
  lookup(presentedKey: string): Promise<ApiKeyRecord | undefined>;
  revoke(keyHash: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  async issue(input: Parameters<ApiKeyStore["issue"]>[0]): Promise<IssuedApiKey> {
    const apiKey = generateApiKey();
    const record: ApiKeyRecord = {
      keyHash: hashApiKey(apiKey),
      tenantId: input.tenantId,
      projectId: input.projectId,
      allowedModels: input.allowedModels ?? [],
      rateLimitTier: input.rateLimitTier,
      active: true,
      createdAt: new Date(),
    };
    this.byHash.set(record.keyHash, record);
    return { apiKey, record };
  }

  async lookup(presentedKey: string): Promise<ApiKeyRecord | undefined> {
    if (!presentedKey.startsWith(API_KEY_PREFIX)) {
      return undefined;
    }
    const found = this.byHash.get(hashApiKey(presentedKey));
    return found?.active ? found : undefined;
  }

  async revoke(keyHash: string): Promise<boolean> {
    const found = this.byHash.get(keyHash);
    if (found === undefined) {
      return false;
    }
    this.byHash.delete(keyHash);
    return true;
  }
}
