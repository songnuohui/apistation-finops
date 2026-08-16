-- ApiStation FinOps v0.53: inventory-threshold and fixed-schedule replenishment strategies.
-- This migration only changes FinOps-owned replenishment configuration.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS trigger_strategy VARCHAR(32) NOT NULL DEFAULT 'inventory_threshold';

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  DROP CONSTRAINT IF EXISTS replenishment_rules_trigger_strategy_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD CONSTRAINT replenishment_rules_trigger_strategy_check
  CHECK (trigger_strategy IN ('inventory_threshold','fixed_schedule'));

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.replenishment_rules.trigger_strategy IS
  'Whether the rule fills an inventory target or buys a fixed quantity on each scheduled execution.';
