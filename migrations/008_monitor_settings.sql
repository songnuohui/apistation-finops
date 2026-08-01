-- ApiStation FinOps v0.8: public monitor refresh settings and source status snapshots.
--
-- This migration is FinOps-owned. It does not alter or write to sub2api.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 30
    CHECK (refresh_interval_seconds >= 5 AND refresh_interval_seconds <= 3600),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{FINOPS_SCHEMA}}.monitor_settings(id, refresh_interval_seconds)
VALUES (TRUE, 30)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_group_observations
  ADD COLUMN IF NOT EXISTS source_availability_percent NUMERIC(5,2);
ALTER TABLE {{FINOPS_SCHEMA}}.monitor_group_observations
  ADD COLUMN IF NOT EXISTS observation_source VARCHAR(40) NOT NULL DEFAULT 'probe';

COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_settings IS
  'FinOps-owned settings for the standalone public group monitoring page.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_group_observations.source_availability_percent IS
  'Availability percentage reported by the configured sub2api channel monitors when available.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_group_observations.observation_source IS
  'Snapshot origin. Public monitoring only uses sub2api_channel_monitor snapshots.';
