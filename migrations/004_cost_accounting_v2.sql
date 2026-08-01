-- ApiStation FinOps v0.4: isolated upstream-rate and fixed-purchase cost accounting.
-- This migration only changes the independent FinOps database. It never reads
-- or writes a sub2api table during migration.

ALTER TABLE {{FINOPS_SCHEMA}}.cost_profiles
  ADD COLUMN IF NOT EXISTS cost_mode VARCHAR(32) NOT NULL DEFAULT 'fixed_purchase',
  ADD COLUMN IF NOT EXISTS basis_mode VARCHAR(32) NOT NULL DEFAULT 'revenue_backsolve',
  ADD COLUMN IF NOT EXISTS cny_per_reference_unit NUMERIC(20,10),
  ADD COLUMN IF NOT EXISTS default_selling_multiplier NUMERIC(20,10);

UPDATE {{FINOPS_SCHEMA}}.cost_profiles
SET cost_mode = CASE
  WHEN cost_type = 'free' THEN 'free'
  ELSE 'fixed_purchase'
END
WHERE cost_mode IS NULL OR cost_mode = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '{{FINOPS_SCHEMA}}.cost_profiles'::regclass
      AND conname = 'cost_profiles_cost_mode_v2'
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.cost_profiles
      ADD CONSTRAINT cost_profiles_cost_mode_v2
      CHECK (cost_mode IN ('probe_multiplier','manual_multiplier','fixed_purchase','free'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '{{FINOPS_SCHEMA}}.cost_profiles'::regclass
      AND conname = 'cost_profiles_basis_mode_v2'
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.cost_profiles
      ADD CONSTRAINT cost_profiles_basis_mode_v2
      CHECK (basis_mode IN ('revenue_backsolve','reference_cny'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.suppliers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(80) NOT NULL DEFAULT '',
  contact_name VARCHAR(120) NOT NULL DEFAULT '',
  contact_details VARCHAR(240) NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_finops_suppliers_name
  ON {{FINOPS_SCHEMA}}.suppliers (LOWER(name));

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.purchase_batches (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.suppliers(id) ON DELETE RESTRICT,
  batch_number VARCHAR(120) NOT NULL,
  total_amount_cny NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (total_amount_cny >= 0),
  fee_amount_cny NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (fee_amount_cny >= 0),
  tax_amount_cny NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (tax_amount_cny >= 0),
  allocation_strategy VARCHAR(32) NOT NULL DEFAULT 'equal'
    CHECK (allocation_strategy IN ('equal','standard_cost_weight','token_weight')),
  purchased_at TIMESTAMPTZ,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','closed','void')),
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_finops_purchase_batches_supplier_number
  ON {{FINOPS_SCHEMA}}.purchase_batches (COALESCE(supplier_id,0), batch_number);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.purchase_batch_allocations (
  id BIGSERIAL PRIMARY KEY,
  purchase_batch_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.purchase_batches(id) ON DELETE CASCADE,
  source_account_id BIGINT NOT NULL,
  allocated_amount_cny NUMERIC(20,8) NOT NULL CHECK (allocated_amount_cny >= 0),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_batch_id, source_account_id),
  CHECK (effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_finops_purchase_batch_allocations_account_period
  ON {{FINOPS_SCHEMA}}.purchase_batch_allocations (source_account_id, effective_from, effective_to);

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_periods
  ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_batch_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.purchase_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS allocated_cost_cny NUMERIC(20,8);

UPDATE {{FINOPS_SCHEMA}}.account_cost_periods
SET allocated_cost_cny = base_amount + fee_amount + tax_amount
WHERE allocated_cost_cny IS NULL;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_cost_rules (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  cost_profile_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.cost_profiles(id) ON DELETE SET NULL,
  cost_mode VARCHAR(32) NOT NULL
    CHECK (cost_mode IN ('probe_multiplier','manual_multiplier','fixed_purchase','free')),
  basis_mode VARCHAR(32) NOT NULL DEFAULT 'revenue_backsolve'
    CHECK (basis_mode IN ('revenue_backsolve','reference_cny')),
  upstream_multiplier NUMERIC(20,10),
  selling_multiplier NUMERIC(20,10),
  cny_per_reference_unit NUMERIC(20,10),
  supplier_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.suppliers(id) ON DELETE SET NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','void')),
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (upstream_multiplier IS NULL OR upstream_multiplier > 0),
  CHECK (selling_multiplier IS NULL OR selling_multiplier > 0),
  CHECK (cny_per_reference_unit IS NULL OR cny_per_reference_unit > 0),
  CHECK (
    cost_mode <> 'manual_multiplier'
    OR upstream_multiplier IS NOT NULL
  ),
  CHECK (
    basis_mode <> 'reference_cny'
    OR cny_per_reference_unit IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_finops_account_cost_rules_active
  ON {{FINOPS_SCHEMA}}.account_cost_rules (source_account_id, effective_from DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.upstream_billing_snapshots (
  id BIGSERIAL PRIMARY KEY,
  source_account_id BIGINT NOT NULL,
  snapshot_key VARCHAR(360) NOT NULL,
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
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_account_id, snapshot_key)
);

CREATE INDEX IF NOT EXISTS idx_finops_upstream_billing_snapshots_account_time
  ON {{FINOPS_SCHEMA}}.upstream_billing_snapshots
  (source_account_id, COALESCE(observed_at, received_at, last_attempt_at) DESC, id DESC);

CREATE OR REPLACE VIEW {{FINOPS_SCHEMA}}.usage_cost_facts AS
WITH resolved AS (
  SELECT
    f.source_usage_id,
    f.source_account_id,
    f.source_user_id,
    f.model,
    f.occurred_at,
    f.user_charge_cny,
    f.standard_cost_usd_reference,
    f.user_rate_multiplier AS source_selling_multiplier,
    f.account_rate_multiplier AS source_upstream_multiplier,
    COALESCE(
      rule.cost_mode,
      rule_profile.cost_mode,
      account_profile.cost_mode,
      CASE
        WHEN account_profile.cost_type = 'free' THEN 'free'
        WHEN fixed_period.id IS NOT NULL THEN 'fixed_purchase'
        ELSE NULL
      END,
      'unconfigured'
    ) AS cost_mode,
    COALESCE(rule.basis_mode, rule_profile.basis_mode, account_profile.basis_mode, 'revenue_backsolve') AS basis_mode,
    COALESCE(rule.selling_multiplier, rule_profile.default_selling_multiplier, NULLIF(f.user_rate_multiplier,0)) AS selling_multiplier,
    COALESCE(rule.cny_per_reference_unit, rule_profile.cny_per_reference_unit) AS cny_per_reference_unit,
    CASE
      WHEN COALESCE(rule.cost_mode, rule_profile.cost_mode, account_profile.cost_mode, '') = 'manual_multiplier'
        THEN COALESCE(rule.upstream_multiplier, rule_profile.variable_multiplier)
      WHEN COALESCE(rule.cost_mode, rule_profile.cost_mode, account_profile.cost_mode, '') = 'probe_multiplier'
        THEN COALESCE(probe.effective_rate_multiplier, NULLIF(f.account_rate_multiplier,0))
      ELSE NULL
    END AS upstream_multiplier,
    CASE
      WHEN probe.id IS NOT NULL THEN 'probe_snapshot'
      WHEN NULLIF(f.account_rate_multiplier,0) IS NOT NULL THEN 'usage_log_snapshot'
      WHEN rule.upstream_multiplier IS NOT NULL THEN 'manual_rule'
      ELSE ''
    END AS upstream_multiplier_source
  FROM {{FINOPS_SCHEMA}}.fact_usage_events f
  LEFT JOIN {{FINOPS_SCHEMA}}.dim_accounts a
    ON a.source_account_id = f.source_account_id
  LEFT JOIN {{FINOPS_SCHEMA}}.cost_profiles account_profile
    ON account_profile.id = a.cost_profile_id
  LEFT JOIN LATERAL (
    SELECT r.*
    FROM {{FINOPS_SCHEMA}}.account_cost_rules r
    WHERE r.source_account_id = f.source_account_id
      AND r.status = 'active'
      AND r.effective_from <= f.occurred_at
      AND (r.effective_to IS NULL OR r.effective_to > f.occurred_at)
    ORDER BY r.effective_from DESC, r.id DESC
    LIMIT 1
  ) rule ON TRUE
  LEFT JOIN {{FINOPS_SCHEMA}}.cost_profiles rule_profile
    ON rule_profile.id = rule.cost_profile_id
  LEFT JOIN LATERAL (
    SELECT s.*
    FROM {{FINOPS_SCHEMA}}.upstream_billing_snapshots s
    WHERE s.source_account_id = f.source_account_id
      AND s.status = 'ok'
      AND s.effective_rate_multiplier > 0
      AND COALESCE(s.observed_at, s.received_at, s.last_attempt_at) <= f.occurred_at
    ORDER BY COALESCE(s.observed_at, s.received_at, s.last_attempt_at) DESC, s.id DESC
    LIMIT 1
  ) probe ON TRUE
  LEFT JOIN LATERAL (
    SELECT p.id
    FROM {{FINOPS_SCHEMA}}.account_cost_periods p
    WHERE p.source_account_id = f.source_account_id
      AND p.status = 'active'
      AND p.effective_from <= f.occurred_at
      AND p.effective_to > f.occurred_at
    ORDER BY p.effective_from DESC, p.id DESC
    LIMIT 1
  ) fixed_period ON TRUE
)
SELECT
  resolved.*,
  CASE
    WHEN cost_mode = 'free' THEN 'free'
    WHEN cost_mode = 'fixed_purchase' THEN 'fixed_cost'
    WHEN cost_mode = 'unconfigured' THEN 'unconfigured'
    WHEN upstream_multiplier IS NULL OR upstream_multiplier <= 0 THEN 'missing_upstream_multiplier'
    WHEN basis_mode = 'reference_cny' AND (cny_per_reference_unit IS NULL OR cny_per_reference_unit <= 0)
      THEN 'missing_cny_basis'
    WHEN basis_mode = 'reference_cny' THEN 'priced'
    WHEN selling_multiplier IS NULL OR selling_multiplier <= 0 THEN 'missing_selling_multiplier'
    ELSE 'priced'
  END AS cost_status,
  CASE
    WHEN cost_mode IN ('probe_multiplier','manual_multiplier')
      AND upstream_multiplier > 0
      AND basis_mode = 'reference_cny'
      AND cny_per_reference_unit > 0
      THEN standard_cost_usd_reference * upstream_multiplier * cny_per_reference_unit
    WHEN cost_mode IN ('probe_multiplier','manual_multiplier')
      AND upstream_multiplier > 0
      AND basis_mode = 'revenue_backsolve'
      AND selling_multiplier > 0
      THEN user_charge_cny * upstream_multiplier / selling_multiplier
    WHEN cost_mode = 'free' THEN 0::numeric
    ELSE NULL
  END AS calculated_cost_cny
FROM resolved;

CREATE OR REPLACE VIEW {{FINOPS_SCHEMA}}.account_fixed_cost_periods AS
SELECT
  p.*,
  COALESCE(p.allocated_cost_cny, p.base_amount + p.fee_amount + p.tax_amount) AS total_cost_cny,
  COALESCE(
    rule.cost_mode,
    profile.cost_mode,
    CASE WHEN profile.cost_type = 'free' THEN 'free' ELSE 'fixed_purchase' END
  ) AS resolved_cost_mode
FROM {{FINOPS_SCHEMA}}.account_cost_periods p
LEFT JOIN {{FINOPS_SCHEMA}}.cost_profiles profile
  ON profile.id = p.cost_profile_id
LEFT JOIN LATERAL (
  SELECT r.cost_mode
  FROM {{FINOPS_SCHEMA}}.account_cost_rules r
  WHERE r.source_account_id = p.source_account_id
    AND r.status = 'active'
    AND r.effective_from <= p.effective_from
    AND (r.effective_to IS NULL OR r.effective_to > p.effective_from)
  ORDER BY r.effective_from DESC, r.id DESC
  LIMIT 1
) rule ON TRUE
WHERE COALESCE(
  rule.cost_mode,
  profile.cost_mode,
  CASE WHEN profile.cost_type = 'free' THEN 'free' ELSE 'fixed_purchase' END
) = 'fixed_purchase';

COMMENT ON TABLE {{FINOPS_SCHEMA}}.upstream_billing_snapshots IS
  'Read-only FinOps copies of sanitized sub2api accounts.extra.upstream_billing_probe snapshots.';
COMMENT ON VIEW {{FINOPS_SCHEMA}}.usage_cost_facts IS
  'Multiplier costs are CNY only when an explicit revenue-backsolve or CNY reference basis exists; no FX is inferred.';
