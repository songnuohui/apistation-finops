-- ApiStation FinOps v0.58: allow alert delivery to be controlled per supplier connection.

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD COLUMN IF NOT EXISTS alert_enabled BOOLEAN NOT NULL DEFAULT TRUE;
