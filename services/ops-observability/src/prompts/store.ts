/**
 * Prisma-backed prompt registry store (O2). Published versions are
 * immutable; promotion walks development → staging → production in order.
 */

import { PrismaClient } from "@prisma/client";

import {
  compareSemver,
  ENVIRONMENT_ORDER,
  type Environment,
  type PromptDto,
  type PromptRegistryStore,
  type VersionDto,
} from "./types.js";

interface PrismaPrompt {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

interface PrismaVersion {
  id: string;
  promptId: string;
  semver: string;
  template: string;
  templateSchema: unknown;
  model: string | null;
  temperature: number | null;
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
  promotions: Array<{ environment: string }>;
}

function toPromptDto(prompt: PrismaPrompt): PromptDto {
  return {
    id: prompt.id,
    tenantId: prompt.tenantId,
    name: prompt.name,
    description: prompt.description,
    createdAt: prompt.createdAt.toISOString(),
  };
}

function toVersionDto(version: PrismaVersion): VersionDto {
  return {
    id: version.id,
    promptId: version.promptId,
    semver: version.semver,
    template: version.template,
    templateSchema:
      version.templateSchema !== null && typeof version.templateSchema === "object"
        ? (version.templateSchema as Record<string, unknown>)
        : null,
    model: version.model,
    temperature: version.temperature,
    status: version.status as VersionDto["status"],
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    environments: version.promotions
      .map((promotion) => promotion.environment as Environment)
      .sort((a, b) => ENVIRONMENT_ORDER[a] - ENVIRONMENT_ORDER[b]),
  };
}

export class PrismaPromptRegistry implements PromptRegistryStore {
  private readonly prisma: PrismaClient;

  constructor(datasourceUrl?: string) {
    this.prisma =
      datasourceUrl !== undefined ? new PrismaClient({ datasourceUrl }) : new PrismaClient();
  }

  async createPrompt(input: {
    tenantId: string;
    name: string;
    description?: string;
  }): Promise<PromptDto> {
    const existing = await this.prisma.prompt.findUnique({
      where: { tenantId_name: { tenantId: input.tenantId, name: input.name } },
    });
    if (existing !== null) {
      return toPromptDto(existing);
    }
    return toPromptDto(
      await this.prisma.prompt.create({
        data: {
          tenantId: input.tenantId,
          name: input.name,
          description: input.description ?? null,
        },
      }),
    );
  }

  async getPrompt(tenantId: string, name: string): Promise<PromptDto | null> {
    const prompt = await this.prisma.prompt.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    return prompt === null ? null : toPromptDto(prompt);
  }

  async listPrompts(tenantId: string): Promise<PromptDto[]> {
    const prompts = await this.prisma.prompt.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
    });
    return prompts.map(toPromptDto);
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
    const clash = await this.prisma.promptVersion.findUnique({
      where: { promptId_semver: { promptId: prompt.id, semver: input.semver } },
    });
    if (clash !== null) {
      throw new VersionExists(name, input.semver);
    }
    return toVersionDto(
      await this.prisma.promptVersion.create({
        data: {
          promptId: prompt.id,
          semver: input.semver,
          template: input.template,
          templateSchema: (input.templateSchema ?? undefined) as never,
          model: input.model ?? null,
          temperature: input.temperature ?? null,
        },
        include: { promotions: true },
      }),
    );
  }

  async listVersions(tenantId: string, name: string): Promise<VersionDto[]> {
    const prompt = await this.mustGetPrompt(tenantId, name);
    const versions = await this.prisma.promptVersion.findMany({
      where: { promptId: prompt.id },
      include: { promotions: true },
    });
    return versions
      .map(toVersionDto)
      .sort((a, b) => compareSemver(b.semver, a.semver));
  }

  async getVersion(tenantId: string, name: string, semver: string): Promise<VersionDto | null> {
    const prompt = await this.prisma.prompt.findUnique({
      where: { tenantId_name: { tenantId, name } },
    });
    if (prompt === null) {
      return null;
    }
    const version = await this.prisma.promptVersion.findUnique({
      where: { promptId_semver: { promptId: prompt.id, semver } },
      include: { promotions: true },
    });
    return version === null ? null : toVersionDto(version);
  }

  async publish(tenantId: string, name: string, semver: string): Promise<VersionDto> {
    const version = await this.mustGetVersion(tenantId, name, semver);
    if (version.status === "archived") {
      throw new ImmutableVersion(name, semver, "archived versions cannot be re-published");
    }
    if (version.status === "published") {
      return version;
    }
    return toVersionDto(
      await this.prisma.promptVersion.update({
        where: { id: version.id },
        data: { status: "published", publishedAt: new Date() },
        include: { promotions: true },
      }),
    );
  }

  async archive(tenantId: string, name: string, semver: string): Promise<VersionDto> {
    const version = await this.mustGetVersion(tenantId, name, semver);
    return toVersionDto(
      await this.prisma.promptVersion.update({
        where: { id: version.id },
        data: { status: "archived" },
        include: { promotions: true },
      }),
    );
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
    // Ordered promotion: every earlier environment must already be promoted.
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
    if (version.environments.includes(environment)) {
      return version;
    }
    await this.prisma.promptPromotion.create({
      data: {
        versionId: version.id,
        environment,
        promotedBy: promotedBy ?? null,
      },
    });
    return this.mustGetVersion(tenantId, name, semver);
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
  ): Promise<VersionDto> {
    const version = await this.getVersion(tenantId, name, semver);
    if (version === null) {
      throw new VersionNotFound(name, semver);
    }
    return version;
  }
}

export class PromptNotFound extends Error {
  constructor(name: string) {
    super(`prompt '${name}' not found`);
    this.name = "PromptNotFound";
  }
}

export class VersionNotFound extends Error {
  constructor(name: string, semver: string) {
    super(`version ${semver} of prompt '${name}' not found`);
    this.name = "VersionNotFound";
  }
}

export class VersionExists extends Error {
  constructor(name: string, semver: string) {
    super(`version ${semver} of prompt '${name}' already exists`);
    this.name = "VersionExists";
  }
}

export class SemverInvalid extends Error {
  constructor(semver: string) {
    super(`'${semver}' is not valid MAJOR.MINOR.PATCH semver`);
    this.name = "SemverInvalid";
  }
}

export class ImmutableVersion extends Error {
  constructor(name: string, semver: string, reason: string) {
    super(`version ${semver} of '${name}' is immutable: ${reason}`);
    this.name = "ImmutableVersion";
  }
}

export class NotPublished extends Error {
  constructor(name: string, semver: string) {
    super(`version ${semver} of '${name}' must be published before promotion`);
    this.name = "NotPublished";
  }
}

export class PromotionOrderSkipped extends Error {
  constructor(name: string, semver: string, missing: Environment, target: Environment) {
    super(`promote '${name}' ${semver}: ${missing} must be promoted before ${target}`);
    this.name = "PromotionOrderSkipped";
  }
}
