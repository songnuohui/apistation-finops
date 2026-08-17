-- ApiStation FinOps v0.55: retain multiplier transitions instead of polling snapshots.
-- This migration changes only the isolated FinOps database.

CREATE INDEX IF NOT EXISTS idx_finops_account_daily_rate_observation
  ON {{FINOPS_SCHEMA}}.account_daily_snapshots (rate_observation_id)
  WHERE rate_observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finops_account_daily_first_rate_observation
  ON {{FINOPS_SCHEMA}}.account_daily_snapshots (first_rate_observation_id)
  WHERE first_rate_observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_rate_observation
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (rate_observation_id)
  WHERE rate_observation_id IS NOT NULL;

DELETE FROM {{FINOPS_SCHEMA}}.supplier_key_observations
WHERE change_type IN ('snapshot', 'quota_changed');

WITH ordered AS MATERIALIZED (
  SELECT
    id,
    jsonb_build_array(
      status,
      billing_scope,
      group_rate_multiplier,
      user_rate_multiplier,
      resolved_rate_multiplier,
      effective_rate_multiplier,
      peak_rate_enabled,
      peak_rate_multiplier,
      applied_peak_multiplier,
      timezone,
      snapshot_data->>'peak_start',
      snapshot_data->>'peak_end'
    ) AS signature,
    LAG(jsonb_build_array(
      status,
      billing_scope,
      group_rate_multiplier,
      user_rate_multiplier,
      resolved_rate_multiplier,
      effective_rate_multiplier,
      peak_rate_enabled,
      peak_rate_multiplier,
      applied_peak_multiplier,
      timezone,
      snapshot_data->>'peak_start',
      snapshot_data->>'peak_end'
    )) OVER (
      PARTITION BY source_account_id, supplier_key_id
      ORDER BY COALESCE(observed_at, received_at, last_attempt_at, captured_at), id
    ) AS previous_signature
  FROM {{FINOPS_SCHEMA}}.account_rate_observations
  WHERE source_kind='supplier_direct_probe'
)
DELETE FROM {{FINOPS_SCHEMA}}.account_rate_observations observation
USING ordered
WHERE observation.id=ordered.id
  AND ordered.signature=ordered.previous_signature;

ANALYZE {{FINOPS_SCHEMA}}.supplier_key_observations;
ANALYZE {{FINOPS_SCHEMA}}.account_rate_observations;
