-- ApiStation FinOps v0.16: supplier connections, inventory, health and alerts.
-- Every object in this migration belongs to the independent FinOps database.

ALTER TABLE {{FINOPS_SCHEMA}}.suppliers
  ADD COLUMN IF NOT EXISTS website_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS supplier_type VARCHAR(32) NOT NULL DEFAULT 'other';

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_connections (
  id BIGSERIAL PRIMARY KEY,
  supplier_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.suppliers(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  adapter_type VARCHAR(32) NOT NULL
    CHECK (adapter_type IN ('auto','sub2api','newapi','openai_compatible','custom')),
  base_url TEXT NOT NULL,
  auth_mode VARCHAR(24) NOT NULL DEFAULT 'password'
    CHECK (auth_mode IN ('password','access_token','api_key')),
  credential_label VARCHAR(255) NOT NULL DEFAULT '',
  credentials_ciphertext TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  inventory_interval_minutes INTEGER NOT NULL DEFAULT 10
    CHECK (inventory_interval_minutes BETWEEN 5 AND 1440),
  active_check_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  active_check_limit INTEGER NOT NULL DEFAULT 20 CHECK (active_check_limit BETWEEN 1 AND 100),
  low_balance_threshold NUMERIC(20,8),
  balance_currency VARCHAR(12) NOT NULL DEFAULT 'USD',
  connection_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending','ok','warning','failed','disabled','unsupported')),
  detected_adapter_type VARCHAR(32) NOT NULL DEFAULT '',
  last_sync_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, name)
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_connections_due
  ON {{FINOPS_SCHEMA}}.supplier_connections (next_sync_at, id)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_keys (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  external_key_id VARCHAR(160) NOT NULL,
  name VARCHAR(200) NOT NULL DEFAULT '',
  masked_key VARCHAR(180) NOT NULL DEFAULT '',
  key_fingerprint VARCHAR(128) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  group_id VARCHAR(120) NOT NULL DEFAULT '',
  group_name VARCHAR(200) NOT NULL DEFAULT '',
  rate_multiplier NUMERIC(20,10),
  quota_total NUMERIC(20,8),
  quota_used NUMERIC(20,8),
  quota_remaining NUMERIC(20,8),
  quota_currency VARCHAR(12) NOT NULL DEFAULT 'USD',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_check_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  last_check_method VARCHAR(40) NOT NULL DEFAULT '',
  last_check_at TIMESTAMPTZ,
  last_check_error TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connection_id, external_key_id)
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_keys_connection_status
  ON {{FINOPS_SCHEMA}}.supplier_keys (connection_id, status, removed_at, id);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_key_observations (
  id BIGSERIAL PRIMARY KEY,
  supplier_key_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  group_name VARCHAR(200) NOT NULL DEFAULT '',
  rate_multiplier NUMERIC(20,10),
  quota_remaining NUMERIC(20,8),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_type VARCHAR(32) NOT NULL DEFAULT 'snapshot',
  snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_key_observations_key_time
  ON {{FINOPS_SCHEMA}}.supplier_key_observations (supplier_key_id, observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_key_checks (
  id BIGSERIAL PRIMARY KEY,
  supplier_key_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  status VARCHAR(24) NOT NULL CHECK (status IN ('ok','failed','unsupported','skipped')),
  method VARCHAR(40) NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  error_code VARCHAR(120) NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_key_checks_key_time
  ON {{FINOPS_SCHEMA}}.supplier_key_checks (supplier_key_id, checked_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_balance_snapshots (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  balance NUMERIC(20,8) NOT NULL,
  currency VARCHAR(12) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_balance_connection_time
  ON {{FINOPS_SCHEMA}}.supplier_balance_snapshots (connection_id, observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_alert_events (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  supplier_key_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  dedupe_key VARCHAR(360) NOT NULL,
  alert_type VARCHAR(48) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info','warning','critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved')),
  title VARCHAR(240) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(120) NOT NULL DEFAULT '',
  resolved_at TIMESTAMPTZ,
  UNIQUE (connection_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_alerts_open
  ON {{FINOPS_SCHEMA}}.supplier_alert_events (connection_id, severity, last_seen_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_account_links (
  supplier_key_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  source_account_id BIGINT NOT NULL,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (supplier_key_id, source_account_id),
  UNIQUE (source_account_id)
);

ALTER TABLE {{FINOPS_SCHEMA}}.account_rate_observations
  ADD COLUMN IF NOT EXISTS supplier_key_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE SET NULL;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_connections IS
  'Encrypted read-only supplier portal connections owned by FinOps.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_keys IS
  'Sanitized supplier key inventory. Full keys are never persisted.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_alert_events IS
  'Deduplicated in-app supplier alerts. Delivery channels can be added later.';
