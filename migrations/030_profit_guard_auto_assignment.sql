-- ApiStation FinOps v0.30: automatically assign profitable, platform-matched sales groups.
-- This migration is FinOps-owned and never writes to the Sub2API database.

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_policies
  ADD COLUMN IF NOT EXISTS auto_assign_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS target_margin_min NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS target_margin_max NUMERIC(12,8);

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_profit_guard_defaults
  ADD COLUMN IF NOT EXISTS auto_assign_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS target_margin_min NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS target_margin_max NUMERIC(12,8);

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_events
  ADD CONSTRAINT account_profit_guard_events_action_check
  CHECK (action IN ('remove_group', 'add_group', 'blocked_last_group'));

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_policies
  ADD CONSTRAINT account_profit_guard_margin_range_check
  CHECK (
    target_margin_min IS NULL
    OR (target_margin_min >= 0 AND target_margin_min <= 1
      AND target_margin_max IS NOT NULL
      AND target_margin_max >= target_margin_min
      AND target_margin_max <= 1)
  );

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_profit_guard_defaults
  ADD CONSTRAINT supplier_profit_guard_margin_range_check
  CHECK (
    target_margin_min IS NULL
    OR (target_margin_min >= 0 AND target_margin_min <= 1
      AND target_margin_max IS NOT NULL
      AND target_margin_max >= target_margin_min
      AND target_margin_max <= 1)
  );
