-- Keep voided cost periods out of the fixed-cost compatibility view while
-- retaining finalized daily snapshots for audit and historical traceability.
CREATE OR REPLACE VIEW {{FINOPS_SCHEMA}}.account_fixed_cost_periods AS
SELECT
  d.account_cost_period_id AS id,
  d.source_account_id,
  d.cost_profile_id,
  p.supplier,
  p.purchase_batch,
  p.original_amount,
  p.original_currency,
  p.fee_amount,
  p.tax_amount,
  d.period_total_cost_cny,
  d.daily_cost_cny AS total_cost_cny,
  d.day_started_at AS effective_from,
  d.day_ended_at AS effective_to,
  d.status,
  COALESCE(p.notes,'') AS notes,
  d.cost_type,
  d.cost_mode,
  d.allocation_method,
  d.day,
  d.finalized,
  d.finalized_at,
  d.captured_at
FROM {{FINOPS_SCHEMA}}.account_cost_daily_snapshots d
LEFT JOIN {{FINOPS_SCHEMA}}.account_cost_periods p ON p.id=d.account_cost_period_id
WHERE d.status='active' AND (p.status='active' OR d.finalized=TRUE);
