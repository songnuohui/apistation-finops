-- ApiStation FinOps v0.16: editable public monitor announcement title.
--
-- This migration is FinOps-owned and does not alter or write to Sub2API.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_settings
  ADD COLUMN IF NOT EXISTS announcement_title VARCHAR(200) NOT NULL DEFAULT '';

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_settings.announcement_title IS
  'Editable plain-text announcement title shown below the fixed public announcement label.';
