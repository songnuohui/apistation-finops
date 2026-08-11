-- ApiStation FinOps v0.35: strategy execution history and unlimited recovery retries.
-- This migration only changes FinOps-owned tables.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_events
  ADD COLUMN IF NOT EXISTS rule_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.replenishment_rules(id);

UPDATE {{FINOPS_SCHEMA}}.replenishment_events event
SET rule_id=COALESCE(run.rule_id, replenishment_order.rule_id)
FROM {{FINOPS_SCHEMA}}.replenishment_events source_event
LEFT JOIN {{FINOPS_SCHEMA}}.replenishment_runs run ON run.id=source_event.run_id
LEFT JOIN {{FINOPS_SCHEMA}}.oauth_supply_orders replenishment_order ON replenishment_order.id=source_event.order_id
WHERE event.id=source_event.id
  AND event.rule_id IS NULL
  AND COALESCE(run.rule_id, replenishment_order.rule_id) IS NOT NULL;

CREATE INDEX IF NOT EXISTS replenishment_events_rule_created_idx
  ON {{FINOPS_SCHEMA}}.replenishment_events(rule_id, created_at DESC, id DESC);

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ALTER COLUMN recovery_retry_limit DROP NOT NULL,
  ALTER COLUMN recovery_retry_limit DROP DEFAULT,
  DROP CONSTRAINT IF EXISTS replenishment_rules_recovery_retry_limit_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD CONSTRAINT replenishment_rules_recovery_retry_limit_check
  CHECK (recovery_retry_limit IS NULL OR recovery_retry_limit BETWEEN 0 AND 20);
