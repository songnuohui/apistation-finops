-- ApiStation FinOps v0.29: supplier-level default profit protection.
-- This remains entirely in the FinOps database and never alters Sub2API data.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_profit_guard_defaults (
  connection_id BIGINT PRIMARY KEY REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_margin NUMERIC(12,8) NOT NULL DEFAULT 0,
  threshold_mode VARCHAR(32) NOT NULL DEFAULT 'margin'
    CHECK (threshold_mode IN ('margin','minimum_sale_multiplier')),
  minimum_sale_multiplier NUMERIC(20,10),
  allow_empty_groups BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (minimum_margin >= 0 AND minimum_margin < 1)
);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_profit_guard_defaults IS
  'FinOps-owned default profit guard policy applied to every account linked to a supplier connection.';
