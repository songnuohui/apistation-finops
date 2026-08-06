-- ApiStation FinOps v0.26: profit protection supports margin and minimum sale thresholds.
-- This migration only changes FinOps-owned tables.

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_policies
  ADD COLUMN IF NOT EXISTS threshold_mode VARCHAR(32) NOT NULL DEFAULT 'margin'
    CHECK (threshold_mode IN ('margin', 'minimum_sale_multiplier')),
  ADD COLUMN IF NOT EXISTS minimum_sale_multiplier NUMERIC(20,10);

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_events
  ADD COLUMN IF NOT EXISTS threshold_mode VARCHAR(32) NOT NULL DEFAULT 'margin'
    CHECK (threshold_mode IN ('margin', 'minimum_sale_multiplier')),
  ADD COLUMN IF NOT EXISTS minimum_sale_multiplier NUMERIC(20,10);
