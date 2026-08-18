-- ApiStation FinOps v0.57: use a five-minute default repair validity window.
-- Existing rule values are preserved; this changes the default for newly created rules only.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ALTER COLUMN repair_grace_seconds SET DEFAULT 300;
