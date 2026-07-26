CREATE SCHEMA IF NOT EXISTS {{FINOPS_SCHEMA}};

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.sync_cursors (
    source_name VARCHAR(64) PRIMARY KEY,
    cursor_time TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
    cursor_id BIGINT NOT NULL DEFAULT 0,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    rows_synced BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.dim_users (
    source_user_id BIGINT PRIMARY KEY,
    email VARCHAR(255) NOT NULL DEFAULT '',
    username VARCHAR(100) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT '',
    current_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
    total_recharged NUMERIC(20,8) NOT NULL DEFAULT 0,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_updated_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.cost_profiles (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    cost_type VARCHAR(30) NOT NULL CHECK (cost_type IN ('metered', 'prepaid', 'subscription', 'one_time', 'free', 'hybrid')),
    currency VARCHAR(12) NOT NULL DEFAULT 'CNY',
    allocation_method VARCHAR(40) NOT NULL DEFAULT 'standard_cost_weight',
    variable_multiplier NUMERIC(20,10) NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    notes TEXT NOT NULL DEFAULT '',
    created_by VARCHAR(120) NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.dim_accounts (
    source_account_id BIGINT PRIMARY KEY,
    name VARCHAR(160) NOT NULL DEFAULT '',
    platform VARCHAR(50) NOT NULL DEFAULT '',
    account_type VARCHAR(30) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ,
    supplier VARCHAR(160) NOT NULL DEFAULT '',
    purchase_batch VARCHAR(120) NOT NULL DEFAULT '',
    cost_profile_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.cost_profiles(id),
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_updated_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.fact_usage_events (
    id BIGSERIAL PRIMARY KEY,
    source_usage_id BIGINT NOT NULL UNIQUE,
    request_id VARCHAR(64) NOT NULL DEFAULT '',
    source_user_id BIGINT NOT NULL DEFAULT 0,
    source_api_key_id BIGINT NOT NULL DEFAULT 0,
    source_account_id BIGINT NOT NULL DEFAULT 0,
    source_group_id BIGINT NOT NULL DEFAULT 0,
    source_channel_id BIGINT NOT NULL DEFAULT 0,
    model VARCHAR(120) NOT NULL DEFAULT '',
    requested_model VARCHAR(120) NOT NULL DEFAULT '',
    upstream_model VARCHAR(120) NOT NULL DEFAULT '',
    billing_mode VARCHAR(30) NOT NULL DEFAULT 'token',
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    user_rate_multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
    account_rate_multiplier NUMERIC(10,4) NOT NULL DEFAULT 1,
    cost_rule_version INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER,
    first_token_ms INTEGER,
    occurred_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_usage_occurred ON {{FINOPS_SCHEMA}}.fact_usage_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_finops_usage_user_time ON {{FINOPS_SCHEMA}}.fact_usage_events (source_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finops_usage_account_time ON {{FINOPS_SCHEMA}}.fact_usage_events (source_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finops_usage_model_time ON {{FINOPS_SCHEMA}}.fact_usage_events (model, occurred_at DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.fact_usage_daily (
    day DATE NOT NULL,
    source_user_id BIGINT NOT NULL DEFAULT 0,
    source_api_key_id BIGINT NOT NULL DEFAULT 0,
    source_account_id BIGINT NOT NULL DEFAULT 0,
    source_group_id BIGINT NOT NULL DEFAULT 0,
    model VARCHAR(120) NOT NULL DEFAULT '',
    billing_mode VARCHAR(30) NOT NULL DEFAULT 'token',
    requests BIGINT NOT NULL DEFAULT 0,
    input_tokens NUMERIC(30,0) NOT NULL DEFAULT 0,
    output_tokens NUMERIC(30,0) NOT NULL DEFAULT 0,
    cache_creation_tokens NUMERIC(30,0) NOT NULL DEFAULT 0,
    cache_read_tokens NUMERIC(30,0) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, source_user_id, source_api_key_id, source_account_id, source_group_id, model, billing_mode)
);

CREATE INDEX IF NOT EXISTS idx_finops_daily_day ON {{FINOPS_SCHEMA}}.fact_usage_daily (day DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.account_cost_periods (
    id BIGSERIAL PRIMARY KEY,
    source_account_id BIGINT NOT NULL,
    cost_profile_id BIGINT REFERENCES {{FINOPS_SCHEMA}}.cost_profiles(id),
    supplier VARCHAR(160) NOT NULL DEFAULT '',
    purchase_batch VARCHAR(120) NOT NULL DEFAULT '',
    original_amount NUMERIC(20,8) NOT NULL,
    original_currency VARCHAR(12) NOT NULL,
    fx_rate NUMERIC(20,10) NOT NULL DEFAULT 1,
    base_amount NUMERIC(20,8) NOT NULL,
    fee_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    notes TEXT NOT NULL DEFAULT '',
    created_by VARCHAR(120) NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_finops_cost_account_period ON {{FINOPS_SCHEMA}}.account_cost_periods (source_account_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.cash_transactions (
    id BIGSERIAL PRIMARY KEY,
    source_table VARCHAR(64) NOT NULL,
    source_id BIGINT NOT NULL,
    transaction_type VARCHAR(40) NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('in', 'out')),
    original_amount NUMERIC(20,8) NOT NULL,
    original_currency VARCHAR(12) NOT NULL,
    fx_rate NUMERIC(20,10) NOT NULL DEFAULT 1,
    base_amount NUMERIC(20,8) NOT NULL,
    source_user_id BIGINT NOT NULL DEFAULT 0,
    source_account_id BIGINT NOT NULL DEFAULT 0,
    payment_method VARCHAR(40) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
    occurred_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_table, source_id, transaction_type)
);

CREATE INDEX IF NOT EXISTS idx_finops_cash_occurred ON {{FINOPS_SCHEMA}}.cash_transactions (occurred_at DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.reconciliation_runs (
    id BIGSERIAL PRIMARY KEY,
    reconciliation_type VARCHAR(40) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    status VARCHAR(24) NOT NULL,
    source_total NUMERIC(24,10) NOT NULL DEFAULT 0,
    finops_total NUMERIC(24,10) NOT NULL DEFAULT 0,
    difference NUMERIC(24,10) NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(160) NOT NULL,
    action VARCHAR(80) NOT NULL,
    object_type VARCHAR(80) NOT NULL,
    object_id VARCHAR(120) NOT NULL,
    before_value JSONB,
    after_value JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
