ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS model_whitelist TEXT[] NOT NULL DEFAULT '{}';
