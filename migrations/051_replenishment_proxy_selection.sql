-- ApiStation FinOps v0.51: persist the Sub2API proxy selected by a replenishment rule.
-- Proxy records remain owned by Sub2API and are only referenced by ID here.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_rules
  ADD COLUMN IF NOT EXISTS proxy_id BIGINT;
