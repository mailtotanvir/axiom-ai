/**
 * Route-level tests for the O2 prompt registry API: secret enforcement,
 * Zod validation, publish/promote flows, diff and render endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createOpsConfig } from "../src/config.js";
import { InMemoryPromptRegistry } from "../src/prompts/memoryStore.js";

const SECRET = "dev-only-inter-service-secret";
const AUTH = { "x-axiom-internal-secret": SECRET };

describe("prompt registry API", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp(
      {
        ...createOpsConfig({ AXIOM_ENV: "test", LOG_LEVEL: "error" }),
        CLICKHOUSE_NODES: undefined,
        POSTGRES_DB_URI: undefined,
      },
      { registry: new InMemoryPromptRegistry() },
    );
  });

  afterAll(async () => {
    await app.closeStores();
    await app.close();
  });

  async function seedPublishedPrompt(): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      headers: AUTH,
      payload: { tenantId: "acme", name: "support-agent", description: "Support replies" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/support-agent/versions?tenant=acme",
      headers: AUTH,
      payload: {
        semver: "1.0.0",
        template: "You are {{agent_name}}, helping with {{topic}}.",
        templateSchema: {
          type: "object",
          properties: { agent_name: { type: "string" }, topic: { type: "string" } },
          required: ["agent_name", "topic"],
          additionalProperties: false,
        },
        model: "openai/gpt-oss-120b",
      },
    });
    const published = await app.inject({
      method: "POST",
      url: "/v1/prompts/support-agent/versions/1.0.0/publish?tenant=acme",
      headers: AUTH,
    });
    return published.json().version.id;
  }

  it("rejects mutations without the inter-service secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { tenantId: "acme", name: "nope" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates a prompt and rejects invalid names via Zod", async () => {
    await seedPublishedPrompt();

    const bad = await app.inject({
      method: "POST",
      url: "/v1/prompts",
      headers: AUTH,
      payload: { tenantId: "acme", name: "bad name!" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("publishes then walks dev → staging promotion in order", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      headers: AUTH,
      payload: { tenantId: "globex", name: "triage" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/triage/versions?tenant=globex",
      headers: AUTH,
      payload: { semver: "0.1.0", template: "Triage {{issue}}" },
    });
    const published = await app.inject({
      method: "POST",
      url: "/v1/prompts/triage/versions/0.1.0/publish?tenant=globex",
      headers: AUTH,
    });
    expect(published.statusCode).toBe(200);

    const skip = await app.inject({
      method: "POST",
      url: "/v1/prompts/triage/versions/0.1.0/promote?tenant=globex",
      headers: AUTH,
      payload: { environment: "production" },
    });
    expect(skip.statusCode).toBe(409);

    for (const env of ["development", "staging"]) {
      const promote = await app.inject({
        method: "POST",
        url: `/v1/prompts/triage/versions/0.1.0/promote?tenant=globex`,
        headers: AUTH,
        payload: { environment: env, promotedBy: "ci-bot" },
      });
      expect(promote.statusCode).toBe(200);
    }
  });

  it("diffs two versions as a unified patch", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      headers: AUTH,
      payload: { tenantId: "acme", name: "diffed" },
    });
    for (const [semver, template] of [
      ["1.0.0", "line one\nline two"],
      ["1.1.0", "line one\nline two changed\nline three"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: `/v1/prompts/diffed/versions?tenant=acme`,
        headers: AUTH,
        payload: { semver, template },
      });
    }
    const diff = await app.inject({
      method: "GET",
      url: "/v1/prompts/diffed/diff?tenant=acme&from=1.0.0&to=1.1.0",
    });
    expect(diff.statusCode).toBe(200);
    const body = diff.json();
    expect(body.patch).toContainEqual("+line two changed");
    expect(body.patch).toContainEqual("-line two");
    expect(body.changedLines).toBe(3); // 1 removal, 2 additions
  });

  it("resolves latest promoted version and renders with validation", async () => {
    // support-agent 1.0.0 is published but only development-promoted here.
    await app.inject({
      method: "POST",
      url: "/v1/prompts/support-agent/versions/1.0.0/promote?tenant=acme",
      headers: AUTH,
      payload: { environment: "development" },
    });

    const badVars = await app.inject({
      method: "POST",
      url: "/v1/prompts/render",
      payload: {
        tenantId: "acme",
        name: "support-agent",
        environment: "development",
        vars: { agent_name: "Axiom" }, // topic missing
      },
    });
    expect(badVars.statusCode).toBe(422);

    const render = await app.inject({
      method: "POST",
      url: "/v1/prompts/render",
      payload: {
        tenantId: "acme",
        name: "support-agent",
        environment: "development",
        vars: { agent_name: "Axiom", topic: "billing" },
      },
    });
    expect(render.statusCode).toBe(200);
    expect(render.json()).toMatchObject({
      version: "1.0.0",
      rendered: "You are Axiom, helping with billing.",
    });
  });

  it("latest returns 404 when nothing is promoted to production yet", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/prompts/support-agent/latest?tenant=acme",
    });
    expect(response.statusCode).toBe(404);
  });
});
