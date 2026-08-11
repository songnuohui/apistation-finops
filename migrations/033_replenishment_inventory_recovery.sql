-- ApiStation FinOps v0.33: effective inventory, quota-aware replenishment, and durable recovery jobs.
-- All state is FinOps-owned. Sub2API remains accessible only through its administrator API.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS target_available_accounts INTEGER NOT NULL DEFAULT 5
    CHECK (target_available_accounts BETWEEN 1 AND 10000),
  ADD COLUMN IF NOT EXISTS quota_used_threshold_percent NUMERIC(5,2) NOT NULL DEFAULT 80
    CHECK (quota_used_threshold_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS quota_window VARCHAR(16) NOT NULL DEFAULT 'any'
    CHECK (quota_window IN ('short', 'long', 'any')),
  ADD COLUMN IF NOT EXISTS quota_unknown_policy VARCHAR(16) NOT NULL DEFAULT 'warn'
    CHECK (quota_unknown_policy IN ('warn', 'low', 'ignore')),
  ADD COLUMN IF NOT EXISTS repair_grace_seconds INTEGER NOT NULL DEFAULT 900
    CHECK (repair_grace_seconds BETWEEN 0 AND 86400),
  ADD COLUMN IF NOT EXISTS recovery_retry_limit INTEGER NOT NULL DEFAULT 6
    CHECK (recovery_retry_limit BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS last_inventory_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE {{FINOPS_SCHEMA}}.replenishment_rules
SET target_available_accounts=GREATEST(
  target_available_accounts,
  min_available_accounts + replenish_quantity
)
WHERE target_available_accounts<=min_available_accounts;

ALTER TABLE {{FINOPS_SCHEMA}}.oauth_supply_order_items
  ADD COLUMN IF NOT EXISTS health_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS quota_used_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS quota_window VARCHAR(16) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_health_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.replenishment_recoveries (
  id BIGSERIAL PRIMARY KEY,
  recovery_key VARCHAR(255) NOT NULL UNIQUE,
  supplier_recovery_id VARCHAR(180),
  order_item_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.oauth_supply_order_items(id) ON DELETE CASCADE,
  rule_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.replenishment_rules(id) ON DELETE CASCADE,
  sub2api_account_id BIGINT NOT NULL,
  account_key VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'waiting_supplier'
    CHECK (status IN (
      'detected','waiting_supplier','claimable','credentials_saved',
      'updating_sub2api','verifying','recovered','retry_wait','manual_required'
    )),
  delivery_status VARCHAR(80) NOT NULL DEFAULT '',
  credential_version VARCHAR(120) NOT NULL DEFAULT '',
  claim_url_ciphertext TEXT NOT NULL DEFAULT '',
  credential_ciphertext TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS replenishment_recoveries_due_idx
  ON {{FINOPS_SCHEMA}}.replenishment_recoveries(status, next_retry_at, updated_at);

CREATE INDEX IF NOT EXISTS replenishment_recoveries_account_idx
  ON {{FINOPS_SCHEMA}}.replenishment_recoveries(sub2api_account_id, updated_at DESC);
