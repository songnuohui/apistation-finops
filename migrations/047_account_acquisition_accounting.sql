-- Recognize fixed account purchases at acquisition time and keep service coverage separate.
-- This migration changes FinOps-owned data only.

CREATE INDEX IF NOT EXISTS idx_finops_cost_period_recognition
  ON {{FINOPS_SCHEMA}}.account_cost_periods (effective_from, source_account_id)
  WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_finops_usage_daily_account_day
  ON {{FINOPS_SCHEMA}}.fact_usage_daily (source_account_id, day);

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_account_order_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items (sub2api_account_id, order_id)
  WHERE sub2api_account_id IS NOT NULL;

WITH corrected AS (
  SELECT
    period.id,
    period.effective_from
      + make_interval(secs => GREATEST(
        1,
        CASE
          WHEN item.metadata->>'remainingSeconds' ~ '^[0-9]+(\.[0-9]+)?$'
            THEN FLOOR((item.metadata->>'remainingSeconds')::numeric)::integer
          ELSE COALESCE(
            (regexp_match(order_row.product,'([0-9]+)d','i'))[1]::integer * 86400,
            30 * 86400
          )
        END
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
FROM corrected
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
