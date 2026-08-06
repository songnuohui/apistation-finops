-- ApiStation FinOps v0.23: queue only FinOps usage rows whose pricing inputs changed.
-- This migration changes only the isolated FinOps database.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.usage_cost_reprice_queue (
  source_usage_id BIGINT PRIMARY KEY
    REFERENCES {{FINOPS_SCHEMA}}.fact_usage_events(source_usage_id) ON DELETE CASCADE,
  reason VARCHAR(48) NOT NULL DEFAULT 'usage_changed',
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_reprice_queue_time
  ON {{FINOPS_SCHEMA}}.usage_cost_reprice_queue (queued_at, source_usage_id);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.usage_cost_reprice_queue IS
  'FinOps-owned work queue for non-finalized request cost snapshots; never writes to Sub2API.';
