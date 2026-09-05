-- Keep uncertain notification delivery in FinOps for manual confirmation.
-- This migration never touches Sub2API tables or schemas.

ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_settings
  DROP CONSTRAINT IF EXISTS model_audit_settings_scan_interval_minutes_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'model_audit_settings_scan_interval_minutes_check'
      AND conrelid = '{{FINOPS_SCHEMA}}.model_audit_settings'::regclass
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_settings
      ADD CONSTRAINT model_audit_settings_scan_interval_minutes_check
      CHECK (scan_interval_minutes BETWEEN 1 AND 1440);
  END IF;
END
$$;

ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_notifications
  ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_notifications
  DROP CONSTRAINT IF EXISTS model_audit_notifications_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'model_audit_notifications_status_check'
      AND conrelid = '{{FINOPS_SCHEMA}}.model_audit_notifications'::regclass
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_notifications
      ADD CONSTRAINT model_audit_notifications_status_check
      CHECK (status IN ('pending','sending','needs_confirmation','sent','failed','skipped'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_model_audit_notifications_confirmable
  ON {{FINOPS_SCHEMA}}.model_audit_notifications (created_at DESC, id DESC)
  WHERE status IN ('pending','sending','needs_confirmation');
