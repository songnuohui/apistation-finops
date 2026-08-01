-- ApiStation FinOps v0.9: retain the site PING reported by sub2api channel monitors.
--
-- This migration only extends FinOps-owned observations. It never changes
-- sub2api tables, services, or monitor configuration.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_group_observations
  ADD COLUMN IF NOT EXISTS average_ping_latency_ms INTEGER;

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_group_observations.average_ping_latency_ms IS
  'Average site PING latency reported by the configured sub2api channel monitors.';
