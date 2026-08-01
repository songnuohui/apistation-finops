-- ApiStation FinOps v0.12: account cost-rule versions and explicit pricing
-- archives. Everything in this migration belongs to the FinOps schema only.

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
  ADD COLUMN IF NOT EXISTS change_strategy VARCHAR(32) NOT NULL DEFAULT 'future_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '{{FINOPS_SCHEMA}}.account_cost_rules'::regclass
      AND conname = 'account_cost_rules_change_strategy_v12'
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
      ADD CONSTRAINT account_cost_rules_change_strategy_v12
      CHECK (change_strategy IN ('future_only','current_day'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_cost_archives (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  usage_snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_snapshot_count >= 0),
  fixed_cost_snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (fixed_cost_snapshot_count >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_account_id, cutoff_at)
);

CREATE INDEX IF NOT EXISTS idx_finops_account_cost_archives_account_time
  ON {{FINOPS_SCHEMA}}.account_cost_archives
  (source_account_id, cutoff_at DESC, id DESC);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.account_cost_archives IS
  'Explicit FinOps-only pricing archive cutoffs. Snapshots before the cutoff are final and cannot be silently repriced.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.account_cost_rules.change_strategy IS
  'Whether the version starts at the edit time or replaces the open local-day rule.';
