-- ApiStation FinOps v0.25: profit protection may remove an account from its last loss-making group.
-- This migration only changes the default for new policies in the FinOps-owned database.

ALTER TABLE {{FINOPS_SCHEMA}}.account_profit_guard_policies
  ALTER COLUMN allow_empty_groups SET DEFAULT TRUE;
