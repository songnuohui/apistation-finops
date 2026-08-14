-- ApiStation FinOps v0.48: materialize read-only Sub2API account filter dimensions.
-- This migration only changes the independent FinOps database.

ALTER TABLE {{FINOPS_SCHEMA}}.dim_accounts
  ADD COLUMN IF NOT EXISTS privacy_mode VARCHAR(80) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS schedulable BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS rate_limit_reset_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temp_unschedulable_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_finops_dim_accounts_filter_dimensions
  ON {{FINOPS_SCHEMA}}.dim_accounts (
    platform, account_type, status, privacy_mode
  )
  WHERE source_deleted_at IS NULL;
