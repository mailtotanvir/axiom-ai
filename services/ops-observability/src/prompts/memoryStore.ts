/**
 * In-memory prompt registry (tests + Postgres-less dev). Mirrors the
 * Prisma store's semantics; a shared behavior test-suite keeps both honest.
 */

import {
  compareSemver,
  ENVIRONMENT_ORDER,
  type Environment,
  type PromptDto,
  type PromptRegistryStore,
  type VersionDto,
} from "./types.js";
import {
  ImmutableVersion,
  NotPublished,
  PromotionOrderSkipped,
  PromptNotFound,
  SemverInvalid,
  VersionExists,
  VersionNotFound,
} from "./store.js";

interface MemoryVersion extends VersionDto {
  promotions: Map<Environment, string>;
}

export class InMemoryPromptRegistry implements PromptRegistryStore {
  private readonly prompts = new Map<string, PromptDto>();
  private readonly versions = new Map<string, Map<string, MemoryVersion>>();

  async createPrompt(input: {
    tenantId: string;
    name: string;
    description?: string;
  }): Promise<PromptDto> {
    const key = `${input.tenantId}/${input.name}`;
    const existing = this.prompts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const prompt: PromptDto = {
      id: `prompt-${this.prompts.size + 1}`,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
      createdAt: new Date().toISOString(),
    };
    this.prompts.set(key, prompt);
    this.versions.set(prompt.id, new Map());
    return prompt;
  }

  async getPrompt(tenantId: string, name: string): Promise<PromptDto | null> {
    return this.prompts.get(`${tenantId}/${name}`) ?? null;
  }

  async listPrompts(tenantId: string): Promise<PromptDto[]> {
    return [...this.prompts.values()]
      .filter((prompt) => prompt.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createVersion(
    tenantId: string,
    name: string,
    input: {
      semver: string;
      template: string;
      templateSchema?: Record<string, unknown>;
      model?: string;
      temperature?: number;
    },
  ): Promise<VersionDto> {
    const prompt = await this.mustGetPrompt(tenantId, name);
    if (!/^\d+\.\d+\.\d+$/.test(input.semver)) {
      throw new SemverInvalid(input.semver);
    }
    const bucket = this.versions.get(prompt.id)!;
    if (bucket.has(input.semver)) {
      throw new VersionExists(name, input.semver);
    }
    const version: MemoryVersion = {
      id: `version-${bucket.size + 1}`,
      promptId: prompt.id,
      semver: input.semver,
      template: input.template,
      templateSchema: input.templateSchema ?? null,
      model: input.model ?? null,
      temperature: input.temperature ?? null,
      status: "draft",
      createdAt: new Date().toISOString(),
      publishedAt: null,
      environments: [],
      promotions: new Map(),
    };
    bucket.set(input.semver, version);
    return this.toDto(version);
  }

  async listVersions(tenantId: string, name: string): Promise<VersionDto[]> {
    const prompt = await this.mustGetPrompt(tenantId, name);
    return [...this.versions.get(prompt.id)!.values()]
      .map((version) => this.toDto(version))
      .sort((a, b) => compareSemver(b.semver, a.semver));
  }

  async getVersion(tenantId: string, name: string, semver: string): Promise<VersionDto | null> {
    const prompt = await this.getPrompt(tenantId, name);
    const version = prompt !== null ? this.versions.get(prompt.id)?.get(semver) : undefined;
    return version === undefined ? null : this.toDto(version);
  }

  async publish(tenantId: string, name: string, semver: string): Promise<VersionDto> {
    const version = await this.mutableVersion(tenantId, name, semver);
    if (version.status === "archived") {
      throw new ImmutableVersion(name, semver, "archived versions cannot be re-published");
    }
    if (version.status === "published") {
      return this.toDto(version);
    }
    version.status = "published";
    version.publishedAt = new Date().toISOString();
    return this.toDto(version);
  }

  async archive(tenantId: string, name: string, semver: string): Promise<VersionDto> {
    const version = await this.mutableVersion(tenantId, name, semver);
    version.status = "archived";
    return this.toDto(version);
  }

  async promote(
    tenantId: string,
    name: string,
    semver: string,
    environment: Environment,
    promotedBy?: string,
  ): Promise<VersionDto> {
    const version = await this.mustGetVersion(tenantId, name, semver);
    if (version.status !== "published") {
      throw new NotPublished(name, semver);
    }
    for (const [candidate, order] of Object.entries(ENVIRONMENT_ORDER) as Array<
      [Environment, number]
    >) {
      if (order >= ENVIRONMENT_ORDER[environment]) {
        break;
      }
      if (!version.environments.includes(candidate)) {
        throw new PromotionOrderSkipped(name, semver, candidate, environment);
      }
    }
    version.promotions.set(environment, promotedBy ?? "system");
    version.environments = [...version.promotions.keys()].sort(
      (a, b) => ENVIRONMENT_ORDER[a] - ENVIRONMENT_ORDER[b],
    );
    return this.toDto(version);
  }

  private toDto(version: MemoryVersion): VersionDto {
    const { promotions: _promotions, ...dto } = version;
    return { ...dto, environments: [...version.environments], templateSchema: version.templateSchema };
  }

  private async mustGetPrompt(tenantId: string, name: string): Promise<PromptDto> {
    const prompt = await this.getPrompt(tenantId, name);
    if (prompt === null) {
      throw new PromptNotFound(name);
    }
    return prompt;
  }

  private async mustGetVersion(
    tenantId: string,
    name: string,
    semver: string,
  ): Promise<MemoryVersion> {
    const prompt = await this.getPrompt(tenantId, name);
    const version = prompt !== null ? this.versions.get(prompt.id)?.get(semver) : undefined;
    if (version === undefined) {
      throw new VersionNotFound(name, semver);
    }
    return version;
  }

  private async mutableVersion(
    tenantId: string,
    name: string,
    semver: string,
  ): Promise<MemoryVersion> {
    return this.mustGetVersion(tenantId, name, semver);
  }
}
