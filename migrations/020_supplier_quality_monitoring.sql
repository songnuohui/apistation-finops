-- ApiStation FinOps v0.20: passive and active supplier quality monitoring.
-- All configuration and observations are FinOps-owned. Supplier API keys
-- remain transient and are never persisted in these tables.

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD COLUMN IF NOT EXISTS quality_monitor_mode VARCHAR(16) NOT NULL DEFAULT 'passive';

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  DROP CONSTRAINT IF EXISTS supplier_connections_quality_monitor_mode_check;

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD CONSTRAINT supplier_connections_quality_monitor_mode_check
  CHECK (quality_monitor_mode IN ('off','passive','active','hybrid'));

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_quality_targets (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  supplier_key_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  model VARCHAR(200) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_seconds INTEGER NOT NULL DEFAULT 1800
    CHECK (interval_seconds BETWEEN 60 AND 86400),
  max_output_tokens INTEGER NOT NULL DEFAULT 1
    CHECK (max_output_tokens BETWEEN 1 AND 32),
  next_probe_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_probe_at TIMESTAMPTZ,
  last_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (last_status IN ('pending','ok','degraded','failed','disabled')),
  last_error TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(120) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_key_id, model)
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_quality_targets_due
  ON {{FINOPS_SCHEMA}}.supplier_quality_targets (next_probe_at, id)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_quality_observations (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.supplier_connections(id) ON DELETE CASCADE,
  supplier_key_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.supplier_keys(id) ON DELETE CASCADE,
  target_id BIGINT
    REFERENCES {{FINOPS_SCHEMA}}.supplier_quality_targets(id) ON DELETE CASCADE,
  source_kind VARCHAR(32) NOT NULL
    CHECK (source_kind IN ('passive_usage','passive_monitor','active_probe')),
  external_observation_id VARCHAR(240),
  model VARCHAR(200) NOT NULL DEFAULT '',
  group_name VARCHAR(200) NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL
    CHECK (status IN ('ok','degraded','failed')),
  availability_sample BOOLEAN NOT NULL DEFAULT FALSE,
  http_status INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  duration_ms INTEGER,
  ping_latency_ms INTEGER,
  rate_multiplier NUMERIC(20,10),
  observed_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
  CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CHECK (ping_latency_ms IS NULL OR ping_latency_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finops_supplier_quality_observation_external
  ON {{FINOPS_SCHEMA}}.supplier_quality_observations
    (connection_id, source_kind, external_observation_id)
  WHERE external_observation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finops_supplier_quality_observations_connection_time
  ON {{FINOPS_SCHEMA}}.supplier_quality_observations
    (connection_id, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_quality_observations_target_time
  ON {{FINOPS_SCHEMA}}.supplier_quality_observations
    (target_id, observed_at DESC, id DESC)
  WHERE target_id IS NOT NULL;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_quality_targets IS
  'Selected supplier key and model pairs used for controlled active TTFT probes.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_quality_observations IS
  'Sanitized passive and active supplier quality samples; no plaintext API keys are stored.';
