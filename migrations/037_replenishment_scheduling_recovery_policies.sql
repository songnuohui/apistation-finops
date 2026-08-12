-- ApiStation FinOps v0.37: independent recovery policies and scheduled replenishment windows.
-- This migration only changes FinOps-owned tables.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS schedule_start_time TIME NOT NULL DEFAULT '00:00',
  ADD COLUMN IF NOT EXISTS schedule_end_time TIME NOT NULL DEFAULT '00:00',
  ADD COLUMN IF NOT EXISTS schedule_interval_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (schedule_interval_seconds BETWEEN 30 AND 86400),
  ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.replenishment_recovery_policies (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL UNIQUE
    REFERENCES {{FINOPS_SCHEMA}}.replenishment_rules(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mode VARCHAR(16) NOT NULL DEFAULT 'manual'
    CHECK (mode IN ('manual','auto')),
  retry_limit INTEGER
    CHECK (retry_limit IS NULL OR retry_limit BETWEEN 0 AND 20),
  retry_interval_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (retry_interval_seconds BETWEEN 15 AND 86400),
  last_scanned_at TIMESTAMPTZ,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{FINOPS_SCHEMA}}.replenishment_recovery_policies(
  rule_id,enabled,mode,retry_limit,retry_interval_seconds,created_by)
SELECT id,TRUE,CASE WHEN mode='auto' THEN 'auto' ELSE 'manual' END,
  recovery_retry_limit,60,'migration-037'
FROM {{FINOPS_SCHEMA}}.replenishment_rules
ON CONFLICT(rule_id) DO NOTHING;

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ADD COLUMN IF NOT EXISTS import_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (import_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS next_import_retry_at TIMESTAMPTZ;

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET status='retry_wait',next_import_retry_at=NOW(),updated_at=NOW()
WHERE verification_status='failed'
  AND credential_ciphertext<>''
  AND status='failed';

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_orders replenishment_order
SET status='import_retry',next_poll_at=NULL,updated_at=NOW()
WHERE status IN ('failed','partial_failed')
  AND EXISTS (
    SELECT 1
    FROM {{FINOPS_SCHEMA}}.oauth_supply_order_items item
    WHERE item.order_id=replenishment_order.id
      AND item.status='retry_wait'
  );

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_import_retry_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items(status,next_import_retry_at,updated_at)
  WHERE status IN ('retry_wait','manual_required');
