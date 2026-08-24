/**
 * Admin API (dev/operator surface): issues and revokes tenant API keys.
 * Guarded by AXIOM_INTER_SERVICE_SECRET — never by regular API keys.
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { errors } from "@axiom-ai/core";

import { requireInternalSecret } from "../auth/middleware.js";
import type { ApiKeyStore } from "../auth/apiKeyStore.js";
import { hashApiKey } from "../auth/apiKeyStore.js";

const issueSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1).default("default"),
  allowedModels: z.array(z.string()).optional(),
  rateLimitTier: z.enum(["free", "pro", "enterprise"]).default("free"),
});

const revokeSchema = z.object({ keyHash: z.string().length(64) });

export function registerAdminRoutes(app: FastifyInstance, keyStore: ApiKeyStore): void {
  app.register(
    async function adminPlugin(admin) {
      requireInternalSecret(admin as unknown as FastifyInstance);

      admin.post("/v1/admin/api-keys", async (request) => {
        const parsed = issueSchema.safeParse(request.body);
        if (!parsed.success) {
          throw errors.validationFailed(parsed.error.flatten());
        }
        const issued = await keyStore.issue({
          tenantId: parsed.data.tenantId,
          projectId: parsed.data.projectId,
          allowedModels: parsed.data.allowedModels,
          rateLimitTier: parsed.data.rateLimitTier,
        });
        return {
          apiKey: issued.apiKey,
          keyHash: issued.record.keyHash,
          tenantId: issued.record.tenantId,
          projectId: issued.record.projectId,
          rateLimitTier: issued.record.rateLimitTier,
          note: "Store this key now; it is not retrievable later.",
        };
      });

      admin.delete("/v1/admin/api-keys/:keyHash", async (request) => {
        const params = revokeSchema.safeParse(request.params);
        if (!params.success) {
          throw errors.validationFailed(params.error.flatten());
        }
        const revoked = await keyStore.revoke(params.data.keyHash);
        if (!revoked) {
          throw errors.notFound("API key");
        }
        return { revoked: true };
      });
    },
    { prefix: "/" },
  );
}

export { hashApiKey };
