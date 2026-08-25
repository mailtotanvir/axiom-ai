-- Prompt registry DDL (O2), applied idempotently by the ops service at
-- startup. Managed here instead of `prisma db push` because the dev
-- Postgres hosts tables owned by other services (destructive drift risk).

CREATE TABLE IF NOT EXISTS prompts (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  description text,
  created_at  timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT prompts_tenant_id_name_key UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id              text PRIMARY KEY,
  prompt_id       text NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  semver          text NOT NULL,
  template        text NOT NULL,
  template_schema jsonb,
  model           text,
  temperature     double precision,
  status          text NOT NULL DEFAULT 'draft',
  created_at      timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at    timestamptz(3),
  CONSTRAINT prompt_versions_prompt_id_semver_key UNIQUE (prompt_id, semver)
);

CREATE INDEX IF NOT EXISTS prompt_versions_prompt_id_status_idx
  ON prompt_versions(prompt_id, status);

CREATE TABLE IF NOT EXISTS prompt_promotions (
  id           text PRIMARY KEY,
  version_id   text NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  environment  text NOT NULL,
  promoted_at  timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_by  text,
  CONSTRAINT prompt_promotions_version_id_environment_key UNIQUE (version_id, environment)
);
