-- ApiStation FinOps v0.46: accelerate date-filtered replenishment lists.
-- These indexes cover FinOps-owned order, recovery, item, and event tables only.

CREATE INDEX IF NOT EXISTS oauth_supply_orders_created_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_orders(created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS oauth_supply_orders_status_created_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_orders(status,created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS replenishment_recoveries_created_idx
  ON {{FINOPS_SCHEMA}}.replenishment_recoveries(created_at DESC,id DESC);

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_recovery_pending_feed_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items(created_at DESC,id DESC)
  WHERE status IN ('retry_wait','manual_required');

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_recovery_completed_feed_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items(created_at DESC,id DESC)
  WHERE status='imported'
    AND verification_status IN ('passed','repaired')
    AND import_attempt_count>0;

CREATE INDEX IF NOT EXISTS replenishment_events_created_idx
  ON {{FINOPS_SCHEMA}}.replenishment_events(created_at DESC,id DESC);
