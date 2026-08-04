-- ApiStation FinOps v0.17: bind multiplier cost rules to sanitized supplier keys.
-- This migration only changes FinOps-owned tables and never touches Sub2API data.

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_rules
  ADD COLUMN IF NOT EXISTS supplier_key_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_finops_account_cost_rules_supplier_key
  ON {{FINOPS_SCHEMA}}.account_cost_rules (supplier_key_id, effective_from DESC)
  WHERE supplier_key_id IS NOT NULL;

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.account_cost_rules.supplier_key_id IS
  'Sanitized FinOps supplier key that supplied the automatic upstream multiplier.';
