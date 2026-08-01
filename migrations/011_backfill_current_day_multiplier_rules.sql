-- ApiStation FinOps v0.11: correct multiplier rules created before the
-- local-midnight effective-time fix. This migration writes only FinOps tables.

WITH clock AS (
  SELECT date_trunc('day', NOW() AT TIME ZONE {{FINOPS_TIMEZONE}})
    AT TIME ZONE {{FINOPS_TIMEZONE}} AS day_start
), first_today_multiplier_rule AS (
  SELECT DISTINCT ON (r.source_account_id)
    r.id,r.source_account_id,r.effective_from
  FROM {{FINOPS_SCHEMA}}.account_cost_rules r
  CROSS JOIN clock
  WHERE r.status IN ('active','superseded')
    AND r.cost_mode IN ('manual_multiplier','probe_multiplier')
    AND r.effective_from >= clock.day_start
    AND r.effective_from < clock.day_start + INTERVAL '1 day'
  ORDER BY r.source_account_id,r.effective_from,r.id
), candidates AS (
  SELECT first_rule.id,clock.day_start
  FROM first_today_multiplier_rule first_rule
  CROSS JOIN clock
  WHERE first_rule.effective_from > clock.day_start
    AND NOT EXISTS (
      SELECT 1
      FROM {{FINOPS_SCHEMA}}.account_cost_rules earlier
      WHERE earlier.source_account_id=first_rule.source_account_id
        AND earlier.status IN ('active','superseded')
        AND earlier.cost_mode IN ('manual_multiplier','probe_multiplier')
        AND earlier.effective_from < clock.day_start
    )
)
UPDATE {{FINOPS_SCHEMA}}.account_cost_rules rule
SET effective_from=candidates.day_start,
    updated_at=NOW()
FROM candidates
WHERE rule.id=candidates.id;
