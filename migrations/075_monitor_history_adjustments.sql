-- ApiStation FinOps v0.17: manually applied monitor history adjustments.
--
-- This feature intentionally changes FinOps-owned monitor history and
-- rollups when an administrator clicks Apply. It never writes to Sub2API.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_group_history_adjustment_settings (
  monitor_group_id BIGINT PRIMARY KEY
    REFERENCES {{FINOPS_SCHEMA}}.monitor_groups(id) ON DELETE CASCADE,
  availability_window VARCHAR(4) NOT NULL DEFAULT '7d',
  target_availability NUMERIC(5,2),
  history_greenify_percent NUMERIC(5,2) NOT NULL DEFAULT 90,
  preserve_latest_status BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (availability_window IN ('7d','15d','30d')),
  CHECK (target_availability IS NULL OR (target_availability >= 0 AND target_availability <= 100)),
  CHECK (history_greenify_percent >= 0 AND history_greenify_percent <= 100)
);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_group_history_adjustment_batches (
  id BIGSERIAL PRIMARY KEY,
  monitor_group_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.monitor_groups(id) ON DELETE CASCADE,
  availability_window VARCHAR(4) NOT NULL,
  target_availability NUMERIC(5,2) NOT NULL,
  history_greenify_percent NUMERIC(5,2) NOT NULL,
  preserve_latest_status BOOLEAN NOT NULL,
  history_before JSONB NOT NULL DEFAULT '[]'::jsonb,
  history_after JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollups_before JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollups_after JSONB NOT NULL DEFAULT '[]'::jsonb,
  changed_history_count INTEGER NOT NULL DEFAULT 0,
  changed_rollup_count INTEGER NOT NULL DEFAULT 0,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at TIMESTAMPTZ,
  reverted_by VARCHAR(120),
  CHECK (availability_window IN ('7d','15d','30d')),
  CHECK (target_availability >= 0 AND target_availability <= 100),
  CHECK (history_greenify_percent >= 0 AND history_greenify_percent <= 100),
  CHECK (changed_history_count >= 0),
  CHECK (changed_rollup_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_monitor_adjustment_batches_group_time
  ON {{FINOPS_SCHEMA}}.monitor_group_history_adjustment_batches
    (monitor_group_id, created_at DESC, id DESC);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_group_history_adjustment_settings IS
  'Persistent per-group parameters for a manually applied FinOps monitor history adjustment.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_group_history_adjustment_batches IS
  'Audited before/after snapshots for manually changed FinOps monitor history and rollups.';
