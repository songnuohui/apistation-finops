-- ApiStation FinOps v0.34: soft-delete lifecycle for replenishment rules and product mappings.
-- Historical orders, costs, and recovery records remain queryable after configuration deletion.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_product_mappings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS replenishment_rules_live_idx
  ON {{FINOPS_SCHEMA}}.replenishment_rules(enabled, product_mapping_id, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS oauth_supply_product_mappings_live_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_product_mappings(enabled, product, platform, id)
  WHERE deleted_at IS NULL;
