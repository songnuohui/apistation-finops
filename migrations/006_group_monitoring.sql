-- ApiStation FinOps v0.6: configurable public group availability monitor.
--
-- All configuration and observations are stored in the independent FinOps
-- schema. The monitor consumes only FinOps' already-sanitized sync copies;
-- it never changes a sub2api service, schema, table, or row.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_groups (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  source_group_id BIGINT NOT NULL CHECK (source_group_id > 0),
  model_label VARCHAR(120) NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0 AND display_order <= 100000),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_group_id)
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_group_observations (
  id BIGSERIAL PRIMARY KEY,
  monitor_group_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.monitor_groups(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(24) NOT NULL CHECK (status IN ('healthy','degraded','unavailable','unknown')),
  available_account_count INTEGER NOT NULL DEFAULT 0 CHECK (available_account_count >= 0),
  total_account_count INTEGER NOT NULL DEFAULT 0 CHECK (total_account_count >= 0),
  group_multiplier NUMERIC(20,10),
  user_multiplier NUMERIC(20,10),
  effective_multiplier NUMERIC(20,10),
  average_latency_ms INTEGER,
  CHECK (available_account_count <= total_account_count),
  CHECK (group_multiplier IS NULL OR group_multiplier >= 0),
  CHECK (user_multiplier IS NULL OR user_multiplier >= 0),
  CHECK (effective_multiplier IS NULL OR effective_multiplier >= 0),
  CHECK (average_latency_ms IS NULL OR average_latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_monitor_groups_display
  ON {{FINOPS_SCHEMA}}.monitor_groups (enabled, display_order, id);

CREATE INDEX IF NOT EXISTS idx_finops_monitor_group_observations_recent
  ON {{FINOPS_SCHEMA}}.monitor_group_observations (monitor_group_id, observed_at DESC, id DESC);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_groups IS
  'FinOps-owned display configuration for standalone group monitoring. source_group_id is a read-only source reference.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_group_observations IS
  'FinOps-owned snapshots derived from already synchronized usage, account, and upstream probe data.';
