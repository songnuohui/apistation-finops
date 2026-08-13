-- Correct recovery attribution, invalid historical timestamps, and OAuth Supply cost periods.
-- This migration changes FinOps-owned data only.

WITH corrected AS (
  SELECT
    rr.id,
    i.status='imported'
      AND i.verification_status IN ('passed','repaired')
      AND i.sub2api_account_id IS NOT NULL AS completed,
    (
      SELECT event.created_at
      FROM {{FINOPS_SCHEMA}}.replenishment_events event
      WHERE event.item_id=rr.order_item_id
        AND event.event_type='recovery_verified'
        AND event.details->>'recoveryId'=rr.id::text
      ORDER BY ABS(EXTRACT(EPOCH FROM (event.created_at-rr.last_seen_at))),event.id DESC
      LIMIT 1
    ) AS verified_at
  FROM {{FINOPS_SCHEMA}}.replenishment_recoveries rr
  JOIN {{FINOPS_SCHEMA}}.oauth_supply_order_items i ON i.id=rr.order_item_id
  WHERE rr.completion_source='manual_claimed'
)
UPDATE {{FINOPS_SCHEMA}}.replenishment_recoveries rr
SET
  status=CASE WHEN corrected.completed THEN 'recovered' ELSE 'waiting_supplier' END,
  completion_source=CASE WHEN corrected.completed THEN 'system' ELSE '' END,
  claimed_at=COALESCE(
    CASE WHEN rr.claimed_at >= TIMESTAMPTZ '2000-01-01' THEN rr.claimed_at END,
    CASE WHEN rr.recovered_at >= TIMESTAMPTZ '2000-01-01' THEN rr.recovered_at END,
    rr.last_seen_at,
    rr.updated_at
  ),
  recovered_at=CASE
    WHEN corrected.completed THEN COALESCE(
      corrected.verified_at,
      CASE WHEN rr.recovered_at >= TIMESTAMPTZ '2000-01-01' THEN rr.recovered_at END,
      rr.last_seen_at,
      rr.updated_at
    )
    ELSE NULL
  END,
  next_retry_at=CASE WHEN corrected.completed THEN NULL ELSE NOW() END,
  last_error=CASE
    WHEN corrected.completed THEN ''
    ELSE '供应商显示补发文件已领取，但 FinOps 没有保存到本次凭据；等待供应商重新提供可领取文件。'
  END,
  updated_at=NOW()
FROM corrected
WHERE corrected.id=rr.id;

UPDATE {{FINOPS_SCHEMA}}.replenishment_events
SET
  event_type='recovery_supplier_claim_observed',
  message='系统检测到供应商补发文件已领取；已根据实际导入和验号结果校正修复状态。'
WHERE event_type='recovery_manual_completed'
  AND created_by='system';

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET metadata=metadata-'expiresAt',
    updated_at=NOW()
WHERE metadata ? 'expiresAt';

WITH corrected_periods AS (
  SELECT
    period.id,
    period.effective_from
      + make_interval(days => COALESCE(
        (regexp_match(order_row.product,'([0-9]+)d','i'))[1]::integer,
        30
      )) AS effective_to
  FROM {{FINOPS_SCHEMA}}.account_cost_periods period
  JOIN {{FINOPS_SCHEMA}}.oauth_supply_order_items item
    ON item.cost_ledger_period_id=period.id
  JOIN {{FINOPS_SCHEMA}}.oauth_supply_orders order_row
    ON order_row.id=item.order_id
  WHERE LOWER(period.supplier)=LOWER('OAuth Supply')
    AND period.purchase_batch LIKE 'oauth-supply:%'
)
UPDATE {{FINOPS_SCHEMA}}.account_cost_periods period
SET effective_to=corrected.effective_to,
    updated_at=NOW()
FROM corrected_periods corrected
WHERE corrected.id=period.id
  AND period.effective_to IS DISTINCT FROM corrected.effective_to;

UPDATE {{FINOPS_SCHEMA}}.purchase_batch_allocations allocation
SET effective_from=period.effective_from,
    effective_to=period.effective_to,
    updated_at=NOW()
FROM {{FINOPS_SCHEMA}}.account_cost_periods period
WHERE period.purchase_batch_id=allocation.purchase_batch_id
  AND period.source_account_id=allocation.source_account_id
  AND LOWER(period.supplier)=LOWER('OAuth Supply')
  AND period.purchase_batch LIKE 'oauth-supply:%'
  AND (
    allocation.effective_from IS DISTINCT FROM period.effective_from
    OR allocation.effective_to IS DISTINCT FROM period.effective_to
  );

WITH batch_ranges AS (
  SELECT
    allocation.purchase_batch_id,
    MIN(allocation.effective_from) AS effective_from,
    MAX(allocation.effective_to) AS effective_to
  FROM {{FINOPS_SCHEMA}}.purchase_batch_allocations allocation
  JOIN {{FINOPS_SCHEMA}}.account_cost_periods period
    ON period.purchase_batch_id=allocation.purchase_batch_id
    AND period.source_account_id=allocation.source_account_id
  WHERE LOWER(period.supplier)=LOWER('OAuth Supply')
    AND period.purchase_batch LIKE 'oauth-supply:%'
  GROUP BY allocation.purchase_batch_id
)
UPDATE {{FINOPS_SCHEMA}}.purchase_batches batch
SET effective_from=ranges.effective_from,
    effective_to=ranges.effective_to,
    updated_at=NOW()
FROM batch_ranges ranges
WHERE ranges.purchase_batch_id=batch.id
  AND (
    batch.effective_from IS DISTINCT FROM ranges.effective_from
    OR batch.effective_to IS DISTINCT FROM ranges.effective_to
  );
