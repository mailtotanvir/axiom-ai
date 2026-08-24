/**
 * Auth middleware (G3): extracts a bearer or x-api-key credential, resolves
 * it to a TenantContext, and rejects with the Axiom error contract.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { errors } from "@axiom-ai/core";

import type { ApiKeyRecord, ApiKeyStore } from "./apiKeyStore.js";
import { API_KEY_PREFIX } from "./apiKeyStore.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by authenticate() for routes that opt in. */
    apiKeyRecord?: ApiKeyRecord;
  }
}

export function extractPresentedKey(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const apiKeyHeader = request.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.startsWith(API_KEY_PREFIX)) {
    return apiKeyHeader.trim();
  }
  return undefined;
}

export async function resolveTenant(
  store: ApiKeyStore,
  request: FastifyRequest,
): Promise<ApiKeyRecord> {
  const presented = extractPresentedKey(request);
  if (presented === undefined) {
    throw errors.unauthenticated();
  }
  const record = await store.lookup(presented);
  if (record === undefined) {
    throw errors.unauthenticated("Unknown or revoked API key.");
  }
  request.apiKeyRecord = record;
  return record;
}

export function requireInternalSecret(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const secret = process.env.AXIOM_INTER_SERVICE_SECRET;
    if (secret === undefined || secret.length < 16) {
      // Misconfiguration: refuse admin surface entirely rather than open it.
      throw errors.internal();
    }
    const header =
      typeof request.headers.authorization === "string"
        ? request.headers.authorization.replace(/^Bearer /, "")
        : "";
    if (header !== secret) {
      throw errors.unauthenticated("Admin endpoints require the inter-service secret.");
    }
  });
}
