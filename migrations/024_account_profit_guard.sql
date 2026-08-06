-- ApiStation FinOps v0.24: account-level protection against unprofitable sales groups.
-- This migration is FinOps-owned and never writes to the Sub2API database.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_profit_guard_policies (
  source_account_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_margin NUMERIC(12,8) NOT NULL DEFAULT 0,
  allow_empty_groups BOOLEAN NOT NULL DEFAULT FALSE,
  last_evaluated_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (minimum_margin >= 0 AND minimum_margin < 1)
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_profit_guard_events (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  supplier_key_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE SET NULL,
  source_group_id BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  upstream_multiplier NUMERIC(20,10),
  group_multiplier NUMERIC(20,10),
  minimum_margin NUMERIC(12,8),
  before_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  after_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_profit_guard_events_account_time
  ON {{FINOPS_SCHEMA}}.account_profit_guard_events(source_account_id, applied_at DESC);
