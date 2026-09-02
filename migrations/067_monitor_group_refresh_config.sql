-- ApiStation FinOps v0.13: per-group display refresh and source-history boundary.
--
-- These fields belong only to FinOps' monitor display configuration. FinOps
-- continues to read Sub2API channel-monitor data through its read-only pool.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD COLUMN IF NOT EXISTS refresh_interval_seconds INTEGER NOT NULL DEFAULT 30
    CHECK (refresh_interval_seconds BETWEEN 15 AND 3600);

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD COLUMN IF NOT EXISTS history_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_groups.refresh_interval_seconds IS
  'FinOps public-page refresh cadence for this group. It never changes Sub2API probes.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_groups.history_started_at IS
  'Only read-only Sub2API monitor observations at or after this timestamp are displayed.';
