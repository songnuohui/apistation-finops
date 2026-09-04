-- Separate diagnostic runs from the formal cursor-based schedule.
-- This migration is FinOps-only and never touches Sub2API tables or schemas.
ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_scan_runs
  ADD COLUMN IF NOT EXISTS run_type VARCHAR(16) NOT NULL DEFAULT 'scheduled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'model_audit_scan_runs_run_type_check'
      AND conrelid = '{{FINOPS_SCHEMA}}.model_audit_scan_runs'::regclass
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_scan_runs
      ADD CONSTRAINT model_audit_scan_runs_run_type_check
      CHECK (run_type IN ('scheduled', 'test'));
  END IF;
END
$$;

-- A historical test may intentionally inspect a usage row that a later
-- scheduled scan will also inspect, so uniqueness is scoped to each run.
ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_events
  DROP CONSTRAINT IF EXISTS model_audit_events_source_usage_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_audit_events_run_usage
  ON {{FINOPS_SCHEMA}}.model_audit_events (scan_run_id, source_usage_id);

CREATE INDEX IF NOT EXISTS idx_model_audit_scan_runs_type_recent
  ON {{FINOPS_SCHEMA}}.model_audit_scan_runs (run_type, started_at DESC, id DESC);
