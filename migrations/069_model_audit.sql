-- FinOps-owned upstream model audit. This migration never touches Sub2API
-- tables or source-side schemas.
CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.model_audit_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  scan_interval_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (scan_interval_minutes BETWEEN 5 AND 1440),
  test_mode BOOLEAN NOT NULL DEFAULT FALSE,
  test_user_emails TEXT[] NOT NULL DEFAULT '{}'::text[],
  test_recipient_email VARCHAR(255) NOT NULL DEFAULT '',
  admin_email VARCHAR(255) NOT NULL DEFAULT '',
  cursor_created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() - INTERVAL '5 minutes'),
  cursor_id BIGINT NOT NULL DEFAULT 0 CHECK (cursor_id >= 0),
  last_record_created_at TIMESTAMPTZ,
  last_record_id BIGINT,
  last_scan_until TIMESTAMPTZ,
  last_scan_started_at TIMESTAMPTZ,
  last_scan_completed_at TIMESTAMPTZ,
  last_scan_status VARCHAR(24) NOT NULL DEFAULT 'never'
    CHECK (last_scan_status IN ('never','running','completed','failed')),
  last_error TEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(160) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO {{FINOPS_SCHEMA}}.model_audit_settings(id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.model_audit_mappings (
  id BIGSERIAL PRIMARY KEY,
  source_model VARCHAR(200) NOT NULL,
  allowed_response_model VARCHAR(200) NOT NULL,
  created_by VARCHAR(160) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(160) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (BTRIM(source_model) <> ''),
  CHECK (BTRIM(allowed_response_model) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_audit_mappings_source
  ON {{FINOPS_SCHEMA}}.model_audit_mappings (LOWER(BTRIM(source_model)));
CREATE INDEX IF NOT EXISTS idx_model_audit_mappings_response
  ON {{FINOPS_SCHEMA}}.model_audit_mappings (LOWER(BTRIM(allowed_response_model)));

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.model_audit_scan_runs (
  id BIGSERIAL PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  cursor_before_created_at TIMESTAMPTZ NOT NULL,
  cursor_before_id BIGINT NOT NULL DEFAULT 0,
  cursor_after_created_at TIMESTAMPTZ NOT NULL,
  cursor_after_id BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed')),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  allowed_mapping_count INTEGER NOT NULL DEFAULT 0 CHECK (allowed_mapping_count >= 0),
  mismatch_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  unknown_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (period_end > period_start),
  CHECK (cursor_after_created_at >= cursor_before_created_at)
);
CREATE INDEX IF NOT EXISTS idx_model_audit_scan_runs_recent
  ON {{FINOPS_SCHEMA}}.model_audit_scan_runs (started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.model_audit_events (
  id BIGSERIAL PRIMARY KEY,
  scan_run_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.model_audit_scan_runs(id) ON DELETE CASCADE,
  source_usage_id BIGINT NOT NULL UNIQUE,
  source_user_id BIGINT NOT NULL DEFAULT 0,
  user_email VARCHAR(255) NOT NULL DEFAULT '',
  requested_model VARCHAR(200) NOT NULL DEFAULT '',
  upstream_model VARCHAR(200) NOT NULL DEFAULT '',
  upstream_response_model VARCHAR(200) NOT NULL DEFAULT '',
  upstream_model_mismatch BOOLEAN,
  allowed_response_model VARCHAR(200) NOT NULL DEFAULT '',
  status VARCHAR(24) NOT NULL
    CHECK (status IN ('matched','allowed_mapping','mismatch','unknown')),
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_model_audit_events_recent
  ON {{FINOPS_SCHEMA}}.model_audit_events (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_model_audit_events_run_status
  ON {{FINOPS_SCHEMA}}.model_audit_events (scan_run_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_model_audit_events_user
  ON {{FINOPS_SCHEMA}}.model_audit_events (LOWER(user_email), created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.model_audit_notifications (
  id BIGSERIAL PRIMARY KEY,
  scan_run_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.model_audit_scan_runs(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('user','admin','test')),
  target_email VARCHAR(255) NOT NULL DEFAULT '',
  recipient_email VARCHAR(255) NOT NULL DEFAULT '',
  subject VARCHAR(255) NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','skipped')),
  error_message TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scan_run_id, kind, recipient_email)
);
CREATE INDEX IF NOT EXISTS idx_model_audit_notifications_recent
  ON {{FINOPS_SCHEMA}}.model_audit_notifications (created_at DESC, id DESC);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.model_audit_settings IS
  'FinOps-only scheduler state and test routing for upstream model mismatch audits.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.model_audit_mappings IS
  'Global explicit upstream model to response model allowlist. Exact identity is always legal.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.model_audit_events IS
  'Immutable snapshots of Sub2API usage log model comparison results.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.model_audit_notifications IS
  'One notification per scan window and recipient, including full rendered email content.';
