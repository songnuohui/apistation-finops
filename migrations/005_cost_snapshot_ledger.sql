-- ApiStation FinOps v0.5: immutable cost facts and daily account snapshots.
--
-- This migration is intentionally limited to the independent FinOps database.
-- It never reads from or writes to a sub2api schema or table.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_rate_observations (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  observation_key VARCHAR(360) NOT NULL,
  source_kind VARCHAR(48) NOT NULL DEFAULT 'sub2api_cached_probe',
  status VARCHAR(24) NOT NULL DEFAULT 'unknown',
  billing_scope VARCHAR(32) NOT NULL DEFAULT '',
  observed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  fresh_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  next_probe_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  group_rate_multiplier NUMERIC(20,10),
  user_rate_multiplier NUMERIC(20,10),
  resolved_rate_multiplier NUMERIC(20,10),
  effective_rate_multiplier NUMERIC(20,10),
  peak_rate_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  peak_rate_multiplier NUMERIC(20,10),
  applied_peak_multiplier NUMERIC(20,10),
  timezone VARCHAR(80) NOT NULL DEFAULT '',
  snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_account_id, observation_key)
);

CREATE INDEX IF NOT EXISTS idx_finops_rate_observations_account_time
  ON {{FINOPS_SCHEMA}}.account_rate_observations
  (source_account_id, COALESCE(observed_at, received_at, last_attempt_at, captured_at) DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_daily_snapshots (
  day DATE NOT NULL,
  source_account_id BIGINT NOT NULL,
  name VARCHAR(160) NOT NULL DEFAULT '',
  platform VARCHAR(50) NOT NULL DEFAULT '',
  account_type VARCHAR(30) NOT NULL DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  source_deleted_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  is_available BOOLEAN NOT NULL DEFAULT FALSE,
  rate_observation_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.account_rate_observations(id) ON DELETE SET NULL,
  first_rate_observation_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.account_rate_observations(id) ON DELETE SET NULL,
  rate_status VARCHAR(24) NOT NULL DEFAULT 'unknown',
  effective_rate_multiplier NUMERIC(20,10),
  rate_change_count INTEGER NOT NULL DEFAULT 0,
  first_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, source_account_id)
);

CREATE INDEX IF NOT EXISTS idx_finops_account_daily_snapshots_account_day
  ON {{FINOPS_SCHEMA}}.account_daily_snapshots (source_account_id, day DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (
  source_usage_id BIGINT PRIMARY KEY REFERENCES {{FINOPS_SCHEMA}}.fact_usage_events(source_usage_id) ON DELETE RESTRICT,
  source_account_id BIGINT NOT NULL DEFAULT 0,
  source_user_id BIGINT NOT NULL DEFAULT 0,
  source_group_id BIGINT NOT NULL DEFAULT 0,
  model VARCHAR(120) NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  user_charge_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  standard_cost_usd_reference NUMERIC(20,10) NOT NULL DEFAULT 0,
  source_selling_multiplier NUMERIC(20,10),
  source_account_multiplier NUMERIC(20,10),
  cost_mode VARCHAR(32) NOT NULL DEFAULT 'unconfigured',
  basis_mode VARCHAR(32) NOT NULL DEFAULT 'revenue_backsolve',
  cost_profile_id BIGINT,
  account_cost_rule_id BIGINT,
  rate_observation_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.account_rate_observations(id) ON DELETE SET NULL,
  selling_multiplier NUMERIC(20,10),
  upstream_multiplier NUMERIC(20,10),
  cny_per_reference_unit NUMERIC(20,10),
  upstream_multiplier_source VARCHAR(48) NOT NULL DEFAULT '',
  cost_status VARCHAR(40) NOT NULL,
  calculated_cost_cny NUMERIC(20,10),
  snapshot_origin VARCHAR(32) NOT NULL DEFAULT 'live_sync',
  pricing_version SMALLINT NOT NULL DEFAULT 1,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cost_mode IN ('probe_multiplier','manual_multiplier','fixed_purchase','free','unconfigured')),
  CHECK (basis_mode IN ('revenue_backsolve','reference_cny')),
  CHECK (snapshot_origin IN ('live_sync','historical_backfill')),
  CHECK (calculated_cost_cny IS NULL OR calculated_cost_cny >= 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_snapshots_account_time
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (source_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_snapshots_user_time
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (source_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_snapshots_status_time
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (cost_status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_cost_daily_snapshots (
  day DATE NOT NULL,
  account_cost_period_id BIGINT NOT NULL,
  source_account_id BIGINT NOT NULL,
  day_started_at TIMESTAMPTZ NOT NULL,
  day_ended_at TIMESTAMPTZ NOT NULL,
  cost_profile_id BIGINT,
  cost_type VARCHAR(30) NOT NULL DEFAULT 'prepaid',
  cost_mode VARCHAR(32) NOT NULL DEFAULT 'fixed_purchase',
  allocation_method VARCHAR(40) NOT NULL DEFAULT 'standard_cost_weight',
  period_total_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  daily_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  snapshot_origin VARCHAR(32) NOT NULL DEFAULT 'live_sync',
  snapshot_version SMALLINT NOT NULL DEFAULT 1,
  finalized BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, account_cost_period_id),
  CHECK (effective_to > effective_from),
  CHECK (daily_cost_cny >= 0),
  CHECK (status IN ('active','void')),
  CHECK (snapshot_origin IN ('live_sync','historical_backfill'))
);

CREATE INDEX IF NOT EXISTS idx_finops_daily_cost_account_day
  ON {{FINOPS_SCHEMA}}.account_cost_daily_snapshots (source_account_id, day DESC)
  WHERE status = 'active';

-- Preserve NULL for legacy usage rows. A NULL means sub2api did not record an
-- account-rate snapshot; it must not silently become a 1.0x cost assumption.
ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_events
  ALTER COLUMN account_rate_multiplier DROP NOT NULL;

-- The previous compatibility view was created by 004_cost_accounting_v2.
-- Drop and recreate it so PostgreSQL does not reject harmless precision/type
-- changes when the immutable snapshot columns are introduced.
DROP VIEW IF EXISTS {{FINOPS_SCHEMA}}.usage_cost_facts;

CREATE VIEW {{FINOPS_SCHEMA}}.usage_cost_facts AS
SELECT
  source_usage_id,
  source_account_id,
  source_user_id,
  model,
  occurred_at,
  user_charge_cny,
  standard_cost_usd_reference,
  source_selling_multiplier,
  source_account_multiplier AS source_upstream_multiplier,
  cost_mode,
  basis_mode,
  selling_multiplier,
  cny_per_reference_unit,
  upstream_multiplier,
  upstream_multiplier_source,
  cost_status,
  calculated_cost_cny
FROM {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots;

DROP VIEW IF EXISTS {{FINOPS_SCHEMA}}.account_fixed_cost_periods;

CREATE VIEW {{FINOPS_SCHEMA}}.account_fixed_cost_periods AS
SELECT
  account_cost_period_id AS id,
  d.source_account_id,
  d.cost_profile_id,
  p.supplier,
  p.purchase_batch,
  p.original_amount,
  p.original_currency,
  p.fee_amount,
  p.tax_amount,
  d.period_total_cost_cny,
  daily_cost_cny AS total_cost_cny,
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
WHERE d.status = 'active';

COMMENT ON TABLE {{FINOPS_SCHEMA}}.account_rate_observations IS
  'Append-only sanitized observations copied from sub2api accounts.extra.upstream_billing_probe by read-only FinOps sync.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.account_daily_snapshots IS
  'Daily FinOps account inventory and latest observed upstream-rate state in the configured accounting timezone.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots IS
  'Immutable request-level cost attribution facts. Historical corrections require an explicit adjustment, never mutation.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.account_cost_daily_snapshots IS
  'Daily fixed-purchase cost facts. Recent open days may be refreshed; finalized days remain immutable.';
COMMENT ON VIEW {{FINOPS_SCHEMA}}.usage_cost_facts IS
  'Compatibility view over immutable request-level FinOps cost snapshots.';
