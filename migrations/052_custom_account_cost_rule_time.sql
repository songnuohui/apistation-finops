-- ApiStation FinOps v0.52: custom effective timestamps for account cost rules.
-- This migration changes only the FinOps-owned rule strategy constraint.

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
  DROP CONSTRAINT IF EXISTS account_cost_rules_change_strategy_v12;

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
  DROP CONSTRAINT IF EXISTS account_cost_rules_change_strategy_v52;

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
  ADD CONSTRAINT account_cost_rules_change_strategy_v52
  CHECK (change_strategy IN ('future_only','current_day','custom_time'));

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.account_cost_rules.change_strategy IS
  'Whether a rule starts at edit time, local-day start, or an explicit timestamp.';
