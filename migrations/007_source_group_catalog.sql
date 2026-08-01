-- ApiStation FinOps v0.7: source group catalog fetched through the existing
-- authenticated sub2api administrator API. This migration writes only to the
-- independent FinOps database.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.source_group_catalog (
  source_group_id BIGINT PRIMARY KEY CHECK (source_group_id > 0),
  name VARCHAR(160) NOT NULL DEFAULT '',
  platform VARCHAR(50) NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL DEFAULT '',
  rate_multiplier NUMERIC(20,10),
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_model VARCHAR(120) NOT NULL DEFAULT '',
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_source_group_catalog_display
  ON {{FINOPS_SCHEMA}}.source_group_catalog (status, sort_order, source_group_id);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.source_group_catalog IS
  'Sanitized sub2api group catalog captured through the existing read-only administrator API; it never writes to sub2api.';
