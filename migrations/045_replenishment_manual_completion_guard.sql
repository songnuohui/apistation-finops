-- ApiStation FinOps v0.45: preserve manual compensation as a final FinOps state.
-- This migration changes FinOps-owned tables only.

UPDATE {{FINOPS_SCHEMA}}.replenishment_recoveries recovery
SET status='recovered',
    completion_source='manual_compensation',
    claim_url_ciphertext='',
    next_retry_at=NULL,
    last_error='',
    recovered_at=COALESCE(
      recovery.recovered_at,
      (
        SELECT event.created_at
        FROM {{FINOPS_SCHEMA}}.replenishment_events event
        WHERE event.item_id=recovery.order_item_id
          AND event.event_type='recovery_manual_compensated'
        ORDER BY event.created_at DESC,event.id DESC
        LIMIT 1
      ),
      recovery.updated_at,
      NOW()
    ),
    last_seen_at=NOW(),
    updated_at=NOW()
FROM {{FINOPS_SCHEMA}}.oauth_supply_order_items item
WHERE item.id=recovery.order_item_id
  AND item.repair_completion_source='manual_compensation'
  AND (
    recovery.status<>'recovered'
    OR recovery.completion_source<>'manual_compensation'
  );

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET health_status='unknown',
    error_message='',
    next_import_retry_at=NULL,
    updated_at=NOW()
WHERE repair_completion_source='manual_compensation'
  AND health_status='repairing';
