-- ApiStation FinOps v0.14: independent operational visibility controls.
-- All tables and columns below belong to FinOps only. Sub2API is read-only.

ALTER TABLE {{FINOPS_SCHEMA}}.dim_users
  ADD COLUMN IF NOT EXISTS exclude_from_balance_stats BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_finops_dim_users_balance_stats
  ON {{FINOPS_SCHEMA}}.dim_users (exclude_from_balance_stats)
  WHERE exclude_from_balance_stats = FALSE;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.user_concurrency_live (
  source_user_id BIGINT PRIMARY KEY,
  email VARCHAR(255) NOT NULL DEFAULT '',
  username VARCHAR(100) NOT NULL DEFAULT '',
  max_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_concurrency >= 0),
  current_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (current_concurrency >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_user_concurrency_live_load
  ON {{FINOPS_SCHEMA}}.user_concurrency_live
  (current_concurrency DESC, max_concurrency DESC, source_user_id);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.runtime_queue_live (
  source_name VARCHAR(64) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode VARCHAR(32) NOT NULL DEFAULT '',
  worker_count INTEGER NOT NULL DEFAULT 0 CHECK (worker_count >= 0),
  active_workers INTEGER NOT NULL DEFAULT 0 CHECK (active_workers >= 0),
  idle_workers INTEGER NOT NULL DEFAULT 0 CHECK (idle_workers >= 0),
  queue_size INTEGER NOT NULL DEFAULT 0 CHECK (queue_size >= 0),
  queue_length INTEGER NOT NULL DEFAULT 0 CHECK (queue_length >= 0),
  queue_usage_percent NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK (queue_usage_percent >= 0),
  processed BIGINT NOT NULL DEFAULT 0 CHECK (processed >= 0),
  errors BIGINT NOT NULL DEFAULT 0 CHECK (errors >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.dim_users.exclude_from_balance_stats IS
  'FinOps-only self-use whitelist. Excluded users do not affect wallet balance totals; their usage and upstream cost remain included.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.user_concurrency_live IS
  'Latest read-only Sub2API administrator user concurrency snapshot.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.runtime_queue_live IS
  'Latest read-only Sub2API runtime queue snapshot.';
