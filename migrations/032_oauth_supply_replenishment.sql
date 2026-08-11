-- ApiStation FinOps v0.32: OAuth Supply replenishment and Sub2API import ledger.
-- All tables are FinOps-owned. OAuth Supply and Sub2API are accessed only through APIs.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.oauth_supply_product_mappings (
  id BIGSERIAL PRIMARY KEY,
  product VARCHAR(120) NOT NULL,
  platform VARCHAR(80) NOT NULL,
  target_pool_key VARCHAR(160) NOT NULL,
  target_group_ids BIGINT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product, platform, target_pool_key)
);

CREATE INDEX IF NOT EXISTS oauth_supply_product_mappings_active_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_product_mappings(enabled, product, platform);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.replenishment_rules (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  product_mapping_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.oauth_supply_product_mappings(id),
  mode VARCHAR(24) NOT NULL DEFAULT 'observe'
    CHECK (mode IN ('observe', 'approval', 'auto')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_available_accounts INTEGER NOT NULL DEFAULT 0 CHECK (min_available_accounts >= 0),
  replenish_quantity INTEGER NOT NULL DEFAULT 1 CHECK (replenish_quantity BETWEEN 1 AND 1000),
  max_order_amount_cny NUMERIC(18,6) CHECK (max_order_amount_cny IS NULL OR max_order_amount_cny >= 0),
  max_daily_amount_cny NUMERIC(18,6) CHECK (max_daily_amount_cny IS NULL OR max_daily_amount_cny >= 0),
  concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 10000),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  verification_model VARCHAR(160) NOT NULL DEFAULT 'gpt-5.6-luna',
  verification_prompt TEXT NOT NULL DEFAULT 'Reply with a short success marker if this account can complete a basic request.',
  poll_interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_seconds BETWEEN 3 AND 3600),
  retry_limit INTEGER NOT NULL DEFAULT 3 CHECK (retry_limit BETWEEN 0 AND 20),
  cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  last_triggered_at TIMESTAMPTZ,
  last_inventory_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS replenishment_rules_active_idx
  ON {{FINOPS_SCHEMA}}.replenishment_rules(enabled, mode, product_mapping_id);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.replenishment_runs (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.replenishment_rules(id),
  trigger VARCHAR(32) NOT NULL DEFAULT 'scheduled',
  mode VARCHAR(24) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'checking',
  requested_quantity INTEGER NOT NULL DEFAULT 0,
  available_before INTEGER,
  quoted_amount_cny NUMERIC(18,6),
  actual_paid_amount_cny NUMERIC(18,6),
  delivered_quantity INTEGER NOT NULL DEFAULT 0,
  valid_quantity INTEGER NOT NULL DEFAULT 0,
  failed_quantity INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS replenishment_runs_recent_idx
  ON {{FINOPS_SCHEMA}}.replenishment_runs(rule_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.oauth_supply_orders (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.replenishment_runs(id),
  rule_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.replenishment_rules(id),
  external_order_id VARCHAR(180),
  idempotency_key VARCHAR(180) NOT NULL UNIQUE,
  product VARCHAR(120) NOT NULL,
  platform VARCHAR(80) NOT NULL,
  target_pool_key VARCHAR(160) NOT NULL,
  requested_quantity INTEGER NOT NULL,
  delivered_quantity INTEGER NOT NULL DEFAULT 0,
  valid_quantity INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(40) NOT NULL DEFAULT 'approval_required',
  quoted_amount_cny NUMERIC(18,6),
  actual_paid_amount_cny NUMERIC(18,6),
  released_amount_cny NUMERIC(18,6),
  payload_ciphertext TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_poll_at TIMESTAMPTZ,
  approved_by VARCHAR(120),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_supply_orders_external_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_orders(external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS oauth_supply_orders_status_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_orders(status, next_poll_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.oauth_supply_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.oauth_supply_orders(id) ON DELETE CASCADE,
  external_item_id VARCHAR(180),
  external_account_key VARCHAR(255),
  account_name VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'delivered',
  verification_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  individual_cost_cny NUMERIC(18,6),
  final_cost_cny NUMERIC(18,6),
  credential_version VARCHAR(120) NOT NULL DEFAULT '',
  credential_ciphertext TEXT NOT NULL DEFAULT '',
  sub2api_account_id BIGINT,
  cost_ledger_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (cost_ledger_status IN ('pending', 'recorded', 'skipped', 'failed')),
  cost_ledger_period_id BIGINT,
  cost_ledger_error TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, external_item_id)
);

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_status_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items(order_id, verification_status, status);

CREATE INDEX IF NOT EXISTS oauth_supply_order_items_cost_pending_idx
  ON {{FINOPS_SCHEMA}}.oauth_supply_order_items(cost_ledger_status, sub2api_account_id)
  WHERE verification_status='passed';

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.replenishment_events (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.replenishment_runs(id),
  order_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.oauth_supply_orders(id),
  item_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.oauth_supply_order_items(id),
  event_type VARCHAR(80) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.oauth_supply_orders IS
  'FinOps-owned OAuth Supply order ledger. Credentials are encrypted at rest.';
