-- ApiStation FinOps v0.44: remove the redundant replenishment order cooldown.
-- Scheduling frequency is controlled by schedule_interval_seconds.

UPDATE {{FINOPS_SCHEMA}}.replenishment_rules
SET cooldown_seconds = 0,
    updated_at = NOW()
WHERE cooldown_seconds <> 0;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ALTER COLUMN cooldown_seconds SET DEFAULT 0;
