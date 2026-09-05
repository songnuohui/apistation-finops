-- ApiStation FinOps v0.15: editable public monitor announcement.
--
-- This migration is FinOps-owned and does not alter or write to Sub2API.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_settings
  ADD COLUMN IF NOT EXISTS announcement_text TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_settings.announcement_text IS
  'Plain-text announcement shown at the top of the public monitoring page; blank hides it.';
