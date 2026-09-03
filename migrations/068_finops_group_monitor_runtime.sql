-- ApiStation FinOps v0.14: FinOps-owned channel probes and bounded history.
--
-- FinOps creates and executes these probes independently. Sub2API remains
-- read-only: only its current group catalog and multiplier are consumed.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD COLUMN IF NOT EXISTS provider VARCHAR(24) NOT NULL DEFAULT 'openai',
  ADD COLUMN IF NOT EXISTS api_mode VARCHAR(32) NOT NULL DEFAULT 'chat_completions',
  ADD COLUMN IF NOT EXISTS endpoint TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS api_key_ciphertext TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS api_key_masked VARCHAR(180) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS primary_model VARCHAR(200) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS extra_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS group_name VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS jitter_seconds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS body_override_mode VARCHAR(16) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS body_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_status VARCHAR(24) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_ping_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_message VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

-- Rows created by the previous display-only implementation do not contain
-- enough information to run an independent FinOps probe. Keep those rows as
-- pending configuration so the upgrade never silently loses admin settings;
-- the scheduler already skips rows without a complete probe configuration.

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  DROP CONSTRAINT IF EXISTS monitor_groups_provider_check,
  DROP CONSTRAINT IF EXISTS monitor_groups_api_mode_check,
  DROP CONSTRAINT IF EXISTS monitor_groups_jitter_check,
  DROP CONSTRAINT IF EXISTS monitor_groups_body_override_mode_check,
  DROP CONSTRAINT IF EXISTS monitor_groups_last_status_check;

ALTER TABLE {{FINOPS_SCHEMA}}.monitor_groups
  ADD CONSTRAINT monitor_groups_provider_check
    CHECK (provider IN ('openai','anthropic','gemini','grok')),
  ADD CONSTRAINT monitor_groups_api_mode_check
    CHECK (api_mode IN ('chat_completions','responses')),
  ADD CONSTRAINT monitor_groups_jitter_check
    CHECK (jitter_seconds >= 0 AND jitter_seconds <= refresh_interval_seconds - 15),
  ADD CONSTRAINT monitor_groups_body_override_mode_check
    CHECK (body_override_mode IN ('off','merge','replace')),
  ADD CONSTRAINT monitor_groups_last_status_check
    CHECK (last_status IN ('unknown','operational','degraded','failed','error'));

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_group_check_history (
  id BIGSERIAL PRIMARY KEY,
  monitor_group_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.monitor_groups(id) ON DELETE CASCADE,
  model VARCHAR(200) NOT NULL,
  status VARCHAR(24) NOT NULL
    CHECK (status IN ('operational','degraded','failed','error')),
  latency_ms INTEGER,
  ping_latency_ms INTEGER,
  message VARCHAR(500) NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CHECK (ping_latency_ms IS NULL OR ping_latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_monitor_group_history_recent
  ON {{FINOPS_SCHEMA}}.monitor_group_check_history
    (monitor_group_id, model, checked_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.monitor_group_daily_rollups (
  monitor_group_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.monitor_groups(id) ON DELETE CASCADE,
  model VARCHAR(200) NOT NULL,
  bucket_date DATE NOT NULL,
  total_checks INTEGER NOT NULL DEFAULT 0 CHECK (total_checks >= 0),
  ok_count INTEGER NOT NULL DEFAULT 0 CHECK (ok_count >= 0 AND ok_count <= total_checks),
  sum_latency_ms BIGINT NOT NULL DEFAULT 0 CHECK (sum_latency_ms >= 0),
  count_latency INTEGER NOT NULL DEFAULT 0 CHECK (count_latency >= 0),
  sum_ping_latency_ms BIGINT NOT NULL DEFAULT 0 CHECK (sum_ping_latency_ms >= 0),
  count_ping_latency INTEGER NOT NULL DEFAULT 0 CHECK (count_ping_latency >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (monitor_group_id, model, bucket_date)
);

CREATE INDEX IF NOT EXISTS idx_finops_monitor_group_rollups_window
  ON {{FINOPS_SCHEMA}}.monitor_group_daily_rollups
    (monitor_group_id, bucket_date DESC, model);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_group_check_history IS
  'FinOps-owned standalone probe history, bounded to the latest 60 rows per monitor and model.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.monitor_group_daily_rollups IS
  'FinOps-owned incremental daily probe aggregates, retained for the latest 30 calendar days.';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.monitor_groups.api_key_ciphertext IS
  'AES-GCM encrypted probe API key; never exposed to the frontend or written to Sub2API.';
