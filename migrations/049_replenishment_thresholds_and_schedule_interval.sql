-- ApiStation FinOps v0.49: allow equal inventory thresholds and 3-second replenishment scheduling.
-- This migration only changes FinOps-owned replenishment rules.

UPDATE {{FINOPS_SCHEMA}}.replenishment_rules
SET min_available_accounts = GREATEST(min_available_accounts, 1);

UPDATE {{FINOPS_SCHEMA}}.replenishment_rules
SET target_available_accounts = GREATEST(target_available_accounts, min_available_accounts);

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  DROP CONSTRAINT IF EXISTS replenishment_rules_min_available_accounts_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_target_available_accounts_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_schedule_interval_seconds_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD CONSTRAINT replenishment_rules_min_available_accounts_check
    CHECK (min_available_accounts >= 1),
  ADD CONSTRAINT replenishment_rules_target_available_accounts_check
    CHECK (target_available_accounts >= min_available_accounts AND target_available_accounts <= 10000),
  ADD CONSTRAINT replenishment_rules_schedule_interval_seconds_check
    CHECK (schedule_interval_seconds BETWEEN 3 AND 86400);
