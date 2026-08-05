-- ApiStation FinOps v0.21: QQ alert delivery through a user-managed OneBot HTTP gateway.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.alert_notification_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  qq_number VARCHAR(20) NOT NULL DEFAULT '',
  onebot_endpoint TEXT NOT NULL DEFAULT '',
  access_token_ciphertext TEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{FINOPS_SCHEMA}}.alert_notification_settings(id)
VALUES(1)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.supplier_alert_deliveries (
  alert_event_id BIGINT NOT NULL
    REFERENCES {{FINOPS_SCHEMA}}.supplier_alert_events(id) ON DELETE CASCADE,
  channel VARCHAR(32) NOT NULL
    CHECK (channel IN ('qq_onebot')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','failed')),
  last_payload_hash VARCHAR(64) NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_event_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_finops_supplier_alert_deliveries_retry
  ON {{FINOPS_SCHEMA}}.supplier_alert_deliveries (next_attempt_at, alert_event_id)
  WHERE status = 'failed';

COMMENT ON TABLE {{FINOPS_SCHEMA}}.alert_notification_settings IS
  'FinOps-owned QQ OneBot notification settings. Access tokens are encrypted with the supplier credential key.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.supplier_alert_deliveries IS
  'FinOps-owned deduplicated delivery state for supplier alerts.';
