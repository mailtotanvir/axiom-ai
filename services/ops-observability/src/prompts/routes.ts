/**
 * Prompt registry HTTP API (O2). Mutations require the inter-service
 * secret; reads are internal-network scoped.
 *
 * Domain errors thrown by stores are mapped to HTTP status codes by
 * error-class name (stores throw typed error classes).
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import { errors } from "@tanvir1971/core";

import { diffLines, unifiedDiff } from "./diff.js";
import { extractVariables, renderTemplate } from "./render.js";
import {
  createPromptSchema,
  createVersionSchema,
  promoteSchema,
  renderSchema,
  SEMVER_PATTERN,
  type Environment,
  type PromptRegistryStore,
} from "./types.js";

export interface PromptRouteDeps {
  registry: PromptRegistryStore;
  internalSecret: string;
}

const DOMAIN_ERROR_STATUS: Record<string, number> = {
  PromptNotFound: 404,
  VersionNotFound: 404,
  VersionExists: 409,
  ImmutableVersion: 409,
  NotPublished: 409,
  PromotionOrderSkipped: 409,
  SemverInvalid: 400,
};

function mapDomainError(error: unknown, reply: FastifyReply): unknown {
  const status = DOMAIN_ERROR_STATUS[error instanceof Error ? error.name : ""];
  if (status !== undefined) {
    return reply.status(status).send(errors.conflict((error as Error).message).toJSON());
  }
  throw error;
}

interface TenantQuery {
  tenant?: string;
}

interface NameParams {
  name: string;
}

interface VersionParams extends NameParams {
  semver: string;
}

interface DiffQuery extends TenantQuery {
  from?: string;
  to?: string;
}

interface LatestQuery extends TenantQuery {
  env?: string;
}

export function registerPromptRoutes(app: FastifyInstance, deps: PromptRouteDeps): void {
  const requireSecret = (request: { headers: Record<string, unknown> }): void => {
    if (request.headers["x-axiom-internal-secret"] !== deps.internalSecret) {
      throw errors.unauthenticated("Missing or invalid inter-service secret.");
    }
  };

  const requireTenant = (
    reply: FastifyReply,
    tenantId: string | undefined,
  ): { ok: true; tenantId: string } | { ok: false } => {
    if (tenantId === undefined || tenantId === "") {
      void reply
        .status(400)
        .send(errors.validationFailed([{ path: "tenant", message: "required" }]));
      return { ok: false };
    }
    return { ok: true, tenantId };
  };

  app.post("/v1/prompts", async (request, reply) => {
    requireSecret(request);
    const parsed = createPromptSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    const prompt = await deps.registry.createPrompt(parsed.data);
    return reply.status(201).send({ prompt });
  });

  app.get<{ Querystring: TenantQuery }>("/v1/prompts", async (request, reply) => {
    const tenant = requireTenant(reply, request.query.tenant);
    if (!tenant.ok) {
      return reply;
    }
    return { prompts: await deps.registry.listPrompts(tenant.tenantId) };
  });

  app.get<{ Params: NameParams; Querystring: TenantQuery }>(
    "/v1/prompts/:name/versions",
    async (request, reply) => {
      const tenant = requireTenant(reply, request.query.tenant);
      if (!tenant.ok) {
        return reply;
      }
      try {
        return { versions: await deps.registry.listVersions(tenant.tenantId, request.params.name) };
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.post<{ Params: NameParams; Querystring: TenantQuery }>(
    "/v1/prompts/:name/versions",
    async (request, reply) => {
      requireSecret(request);
      const parsed = createVersionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
      }
      const tenant = requireTenant(reply, request.query.tenant);
      if (!tenant.ok) {
        return reply;
      }
      try {
        const version = await deps.registry.createVersion(
          tenant.tenantId,
          request.params.name,
          parsed.data,
        );
        return reply.status(201).send({ version });
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.post<{ Params: VersionParams; Querystring: TenantQuery }>(
    "/v1/prompts/:name/versions/:semver/publish",
    async (request, reply) => {
      requireSecret(request);
      const tenant = requireTenant(reply, request.query.tenant);
      if (!tenant.ok) {
        return reply;
      }
      if (!SEMVER_PATTERN.test(request.params.semver)) {
        return reply.status(400).send(errors.validationFailed().toJSON());
      }
      try {
        return {
          version: await deps.registry.publish(
            tenant.tenantId,
            request.params.name,
            request.params.semver,
          ),
        };
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.post<{ Params: VersionParams; Querystring: TenantQuery }>(
    "/v1/prompts/:name/versions/:semver/promote",
    async (request, reply) => {
      requireSecret(request);
      const parsed = promoteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
      }
      const tenant = requireTenant(reply, request.query.tenant);
      if (!tenant.ok) {
        return reply;
      }
      try {
        return {
          version: await deps.registry.promote(
            tenant.tenantId,
            request.params.name,
            request.params.semver,
            parsed.data.environment,
            parsed.data.promotedBy,
          ),
        };
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.get<{ Params: NameParams; Querystring: DiffQuery }>(
    "/v1/prompts/:name/diff",
    async (request, reply) => {
      const missing = (["tenant", "from", "to"] as const)
        .filter((key) => request.query[key] === undefined || request.query[key] === "")
        .map((key) => ({ path: key, message: "required" }));
      if (missing.length > 0) {
        return reply.status(400).send(errors.validationFailed(missing).toJSON());
      }
      const { from, to } = request.query as { from: string; to: string };
      try {
        const [fromVersion, toVersion] = await Promise.all([
          deps.registry.getVersion(request.query.tenant!, request.params.name, from),
          deps.registry.getVersion(request.query.tenant!, request.params.name, to),
        ]);
        if (fromVersion === null || toVersion === null) {
          return reply.status(404).send(errors.notFound("Version").toJSON());
        }
        const patch = unifiedDiff(from, to, fromVersion.template, toVersion.template);
        const changedLines = diffLines(
          fromVersion.template,
          toVersion.template,
        ).filter((line) => line.kind !== "context").length;
        return { from: fromVersion.semver, to: toVersion.semver, changedLines, patch };
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.get<{ Params: NameParams; Querystring: LatestQuery }>(
    "/v1/prompts/:name/latest",
    async (request, reply) => {
      const tenant = requireTenant(reply, request.query.tenant);
      if (!tenant.ok) {
        return reply;
      }
      const environment: Environment =
        (request.query.env as Environment | undefined) ?? "production";
      try {
        const versions = await deps.registry.listVersions(tenant.tenantId, request.params.name);
        const latest = versions.find(
          (version) =>
            version.status === "published" && version.environments.includes(environment),
        );
        if (latest === undefined) {
          return reply.status(404).send(errors.notFound("Published version").toJSON());
        }
        return { version: latest, variables: extractVariables(latest.template) };
      } catch (error) {
        return mapDomainError(error, reply);
      }
    },
  );

  app.post("/v1/prompts/render", async (request, reply) => {
    const parsed = renderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errors.validationFailed(parsed.error.issues).toJSON());
    }
    try {
      const versions = await deps.registry.listVersions(parsed.data.tenantId, parsed.data.name);
      const latest = versions.find(
        (version) =>
          version.status === "published" && version.environments.includes(parsed.data.environment),
      );
      if (latest === undefined) {
        return reply.status(404).send(errors.notFound("Published version").toJSON());
      }
      const result = renderTemplate(
        `${parsed.data.tenantId}/${parsed.data.name}@${latest.semver}`,
        latest.template,
        parsed.data.vars,
        latest.templateSchema,
      );
      if (!result.ok) {
        return reply.status(422).send(errors.validationFailed(result.errors).toJSON());
      }
      return {
        prompt: parsed.data.name,
        version: latest.semver,
        environment: parsed.data.environment,
        rendered: result.rendered,
      };
    } catch (error) {
      return mapDomainError(error, reply);
    }
  });
}
