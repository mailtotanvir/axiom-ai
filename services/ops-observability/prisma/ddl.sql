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

-- Eval engine (O3)
CREATE TABLE IF NOT EXISTS golden_datasets (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  version    integer NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT golden_datasets_tenant_id_name_version_key UNIQUE (tenant_id, name, version)
);

CREATE TABLE IF NOT EXISTS golden_cases (
  id          text PRIMARY KEY,
  dataset_id  text NOT NULL REFERENCES golden_datasets(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  vars        jsonb NOT NULL,
  expected    jsonb NOT NULL,
  CONSTRAINT golden_cases_dataset_id_external_id_key UNIQUE (dataset_id, external_id)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  dataset_name    text NOT NULL,
  dataset_version integer NOT NULL,
  prompt_name     text NOT NULL,
  prompt_version  text NOT NULL,
  model           text NOT NULL,
  status          text NOT NULL DEFAULT 'running',
  overall_score   double precision,
  case_count      integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  started_at      timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     timestamptz(3)
);

CREATE INDEX IF NOT EXISTS eval_runs_tenant_dataset_started_idx
  ON eval_runs(tenant_id, dataset_name, started_at);

-- A/B experimentation (O4)
CREATE TABLE IF NOT EXISTS experiments (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  targeting_models jsonb,
  created_at       timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT experiments_tenant_id_name_key UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS experiment_arms (
  id            text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  weight        integer NOT NULL,
  model         text,
  prompt_name   text,
  prompt_semver text,
  CONSTRAINT experiment_arms_experiment_id_name_key UNIQUE (experiment_id, name)
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id            text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  arm_name      text NOT NULL,
  key_hash      text NOT NULL,
  request_id    text,
  created_at    timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS experiment_assignments_experiment_key_idx
  ON experiment_assignments(experiment_id, key_hash);

CREATE INDEX IF NOT EXISTS experiment_assignments_experiment_created_idx
  ON experiment_assignments(experiment_id, created_at);

CREATE TABLE IF NOT EXISTS experiment_outcomes (
  id            text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  key_hash      text NOT NULL,
  value         double precision NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS experiment_outcomes_experiment_key_idx
  ON experiment_outcomes(experiment_id, key_hash);
