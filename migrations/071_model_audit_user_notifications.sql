-- Control whether formal model-audit alerts are sent to affected users.
-- This migration is FinOps-only and never touches Sub2API tables or schemas.
ALTER TABLE {{FINOPS_SCHEMA}}.model_audit_settings
  ADD COLUMN IF NOT EXISTS notify_user_emails BOOLEAN NOT NULL DEFAULT TRUE;
