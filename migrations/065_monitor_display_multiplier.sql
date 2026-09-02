-- ApiStation FinOps v0.11: optional display-only multiplier override.
--
-- This value belongs to FinOps presentation configuration. It never changes
-- Sub2API billing rules or any source-side group data.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD COLUMN IF NOT EXISTS display_multiplier NUMERIC(20,10);

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  DROP CONSTRAINT IF EXISTS monitor_groups_display_multiplier_check;

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD CONSTRAINT monitor_groups_display_multiplier_check
  CHECK (display_multiplier IS NULL OR display_multiplier > 0);

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_groups.display_multiplier IS
  'Optional FinOps-only multiplier shown on the group monitor; NULL follows the current Sub2API group rate.';
