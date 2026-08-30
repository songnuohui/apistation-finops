-- FinOps-owned email interruption recovery. This migration never touches Sub2API tables.
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_campaigns
  DROP CONSTRAINT IF EXISTS finops_email_campaigns_status_check;
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_campaigns
  ADD CONSTRAINT finops_email_campaigns_status_check
  CHECK (status IN ('draft','sending','interrupted','completed','partial_failed','failed'));

ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_recipients
  DROP CONSTRAINT IF EXISTS finops_email_recipients_status_check;
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_recipients
  ADD CONSTRAINT finops_email_recipients_status_check
  CHECK (status IN ('pending','needs_review','sent','failed','skipped_unsubscribed','skipped_whitelist','skipped_inactive','skipped_invalid'));

ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_recipients
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(160) NOT NULL DEFAULT '';

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.finops_email_recipients.reviewed_at IS
  'Time an administrator resolved an uncertain delivery after an interrupted FinOps send.';
