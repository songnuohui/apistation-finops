-- ApiStation FinOps v0.13: explicitly audited historical multiplier repricing.
-- This migration writes only the independent FinOps schema.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_cost_reprice_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NOT NULL,
  cost_mode VARCHAR(32) NOT NULL
    CHECK (cost_mode IN ('probe_multiplier','manual_multiplier','free')),
  basis_mode VARCHAR(32) NOT NULL
    CHECK (basis_mode IN ('revenue_backsolve','reference_cny')),
  upstream_multiplier NUMERIC(20,10),
  selling_multiplier NUMERIC(20,10),
  cny_per_reference_unit NUMERIC(20,10),
  affected_usage_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_usage_count >= 0),
  before_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  after_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to > effective_from),
  CHECK (upstream_multiplier IS NULL OR upstream_multiplier > 0),
  CHECK (selling_multiplier IS NULL OR selling_multiplier > 0),
  CHECK (cny_per_reference_unit IS NULL OR cny_per_reference_unit > 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_cost_reprice_jobs_account_time
  ON {{FINOPS_SCHEMA}}.account_cost_reprice_jobs
  (source_account_id, effective_to DESC, id DESC);

ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots
  ADD COLUMN IF NOT EXISTS last_reprice_job_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.account_cost_reprice_jobs(id) ON DELETE SET NULL;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.account_cost_reprice_jobs IS
  'Audited, explicit historical cost corrections. Normal sync never rewrites finalized facts.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots.last_reprice_job_id IS
  'The latest audited historical reprice that intentionally changed this FinOps cost snapshot.';
