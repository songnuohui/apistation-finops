-- ApiStation FinOps v0.56: finite-quota demand forecasting for OAuth Supply replenishment.
-- All configuration and snapshots are FinOps-owned. Sub2API remains read-only.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  DROP CONSTRAINT IF EXISTS replenishment_rules_trigger_strategy_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD CONSTRAINT replenishment_rules_trigger_strategy_check
  CHECK (trigger_strategy IN ('inventory_threshold','fixed_schedule','smart_forecast'));

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS forecast_lookback_hours INTEGER NOT NULL DEFAULT 168,
  ADD COLUMN IF NOT EXISTS forecast_coverage_hours INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS forecast_safety_factor NUMERIC(8,4) NOT NULL DEFAULT 1.2,
  ADD COLUMN IF NOT EXISTS forecast_fallback_lead_time_hours NUMERIC(8,2) NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS forecast_default_account_capacity NUMERIC(24,10),
  ADD COLUMN IF NOT EXISTS last_forecast_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_forecast_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  DROP CONSTRAINT IF EXISTS replenishment_rules_forecast_lookback_hours_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_forecast_coverage_hours_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_forecast_safety_factor_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_forecast_fallback_lead_time_hours_check,
  DROP CONSTRAINT IF EXISTS replenishment_rules_forecast_default_account_capacity_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD CONSTRAINT replenishment_rules_forecast_lookback_hours_check
    CHECK (forecast_lookback_hours BETWEEN 24 AND 720),
  ADD CONSTRAINT replenishment_rules_forecast_coverage_hours_check
    CHECK (forecast_coverage_hours BETWEEN 1 AND 168),
  ADD CONSTRAINT replenishment_rules_forecast_safety_factor_check
    CHECK (forecast_safety_factor BETWEEN 1 AND 3),
  ADD CONSTRAINT replenishment_rules_forecast_fallback_lead_time_hours_check
    CHECK (forecast_fallback_lead_time_hours BETWEEN 0.25 AND 168),
  ADD CONSTRAINT replenishment_rules_forecast_default_account_capacity_check
    CHECK (forecast_default_account_capacity IS NULL OR forecast_default_account_capacity > 0);

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.replenishment_rules.last_forecast_snapshot IS
  'Latest finite 7-day quota capacity forecast. Contains aggregates only, never raw Sub2API usage events.';

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ADD COLUMN IF NOT EXISTS capacity_started_at TIMESTAMPTZ;

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items item
SET capacity_started_at=GREATEST(item.created_at,recovery.latest_recovered_at)
FROM (
  SELECT order_item_id,MAX(recovered_at) AS latest_recovered_at
  FROM {{FINOPS_SCHEMA}}.replenishment_recoveries
  WHERE status='recovered' AND recovered_at IS NOT NULL
  GROUP BY order_item_id
) recovery
WHERE item.id=recovery.order_item_id
  AND item.capacity_started_at IS NULL;

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET capacity_started_at=created_at
WHERE capacity_started_at IS NULL;

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ALTER COLUMN capacity_started_at SET DEFAULT NOW(),
  ALTER COLUMN capacity_started_at SET NOT NULL;

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.oauth_supply_order_items.capacity_started_at IS
  'Start of the current non-recovering 7-day quota generation; reset after a successful credential replacement.';
