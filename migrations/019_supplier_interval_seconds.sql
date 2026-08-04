-- ApiStation FinOps v0.19: supplier inventory polling uses seconds.
-- The legacy minutes column remains for backwards compatibility with older
-- binaries; all new reads and writes use inventory_interval_seconds.

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD COLUMN IF NOT EXISTS inventory_interval_seconds INTEGER;

UPDATE {{FINOPS_SCHEMA}}.supplier_connections
SET inventory_interval_seconds = GREATEST(3, COALESCE(inventory_interval_minutes, 10) * 60)
WHERE inventory_interval_seconds IS NULL;

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ALTER COLUMN inventory_interval_seconds SET DEFAULT 600,
  ALTER COLUMN inventory_interval_seconds SET NOT NULL;

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  DROP CONSTRAINT IF EXISTS supplier_connections_inventory_interval_seconds_check;

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD CONSTRAINT supplier_connections_inventory_interval_seconds_check
  CHECK (inventory_interval_seconds BETWEEN 3 AND 86400);

