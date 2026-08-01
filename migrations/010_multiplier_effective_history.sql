-- ApiStation FinOps v0.10: open-day multiplier history and request snapshot
-- finalization. This migration only changes the independent FinOps database.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.group_selling_rate_rules (
  id BIGSERIAL PRIMARY KEY,
  source_group_id BIGINT NOT NULL CHECK (source_group_id > 0),
  selling_multiplier NUMERIC(20,10) NOT NULL CHECK (selling_multiplier > 0),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  status VARCHAR(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','void')),
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_finops_group_selling_rate_rules_time
  ON {{FINOPS_SCHEMA}}.group_selling_rate_rules
  (source_group_id, effective_from DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_finops_group_selling_rate_rules_active
  ON {{FINOPS_SCHEMA}}.group_selling_rate_rules (source_group_id)
  WHERE status = 'active' AND effective_to IS NULL;

ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots
  ADD COLUMN IF NOT EXISTS selling_rate_rule_id BIGINT,
  ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_snapshots_open_day
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (occurred_at, finalized)
  WHERE finalized = FALSE;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.group_selling_rate_rules IS
  'FinOps-owned historical selling multipliers captured from the read-only sub2api group catalog.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots.finalized IS
  'Closed historical request pricing facts are immutable; open-day facts may be refreshed.';
