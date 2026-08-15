-- ApiStation FinOps v0.50: persist Sub2API account settings on replenishment rules.
-- This migration only changes the FinOps-owned replenishment rule table.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS load_factor INTEGER
    CHECK (load_factor IS NULL OR load_factor BETWEEN 1 AND 10000),
  ADD COLUMN IF NOT EXISTS rate_multiplier NUMERIC(10,4) NOT NULL DEFAULT 1
    CHECK (rate_multiplier >= 0),
  ADD COLUMN IF NOT EXISTS auto_pause_on_expired BOOLEAN NOT NULL DEFAULT TRUE;
