-- ApiStation FinOps v0.43: persist explicit manual compensation completion.
-- This migration changes FinOps-owned tables only.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_recoveries
  DROP CONSTRAINT IF EXISTS replenishment_recoveries_completion_source_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_recoveries
  ADD CONSTRAINT replenishment_recoveries_completion_source_check
  CHECK (completion_source IN ('','system','manual_claimed','manual_compensation'));

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ADD COLUMN IF NOT EXISTS repair_completion_source VARCHAR(32) NOT NULL DEFAULT '';

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  DROP CONSTRAINT IF EXISTS oauth_supply_order_items_repair_completion_source_check;

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ADD CONSTRAINT oauth_supply_order_items_repair_completion_source_check
  CHECK (repair_completion_source IN ('','system','manual_compensation'));
