-- FinOps-owned background email delivery state. This migration never touches Sub2API tables.
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_recipients
  DROP CONSTRAINT IF EXISTS finops_email_recipients_status_check;
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_recipients
  ADD CONSTRAINT finops_email_recipients_status_check
  CHECK (status IN ('pending','sending','needs_review','sent','failed','skipped_unsubscribed','skipped_whitelist','skipped_inactive','skipped_invalid'));

ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_campaigns
  ADD COLUMN IF NOT EXISTS delivery_version SMALLINT NOT NULL DEFAULT 1
  CHECK (delivery_version IN (1,2));

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.finops_email_campaigns.delivery_version IS
  'Delivery state protocol. Version 2 distinguishes an in-flight recipient from recipients not yet attempted.';
