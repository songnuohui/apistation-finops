-- FinOps-owned email campaigns. This migration never touches Sub2API tables.
CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.finops_email_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_host VARCHAR(255) NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_secure BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_username VARCHAR(255) NOT NULL DEFAULT '',
  smtp_credentials_ciphertext TEXT NOT NULL DEFAULT '',
  from_email VARCHAR(255) NOT NULL DEFAULT '',
  from_name VARCHAR(160) NOT NULL DEFAULT '',
  updated_by VARCHAR(160) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO {{FINOPS_SCHEMA}}.finops_email_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.finops_email_preferences (
  source_user_id BIGINT PRIMARY KEY,
  email VARCHAR(255) NOT NULL DEFAULT '',
  subscribed BOOLEAN NOT NULL DEFAULT TRUE,
  unsubscribed_at TIMESTAMPTZ,
  resubscribed_at TIMESTAMPTZ,
  updated_source VARCHAR(40) NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_finops_email_preferences_email
  ON {{FINOPS_SCHEMA}}.finops_email_preferences (LOWER(email));

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.finops_email_campaigns (
  id BIGSERIAL PRIMARY KEY,
  subject VARCHAR(255) NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'announcement' CHECK (category IN ('announcement','promotion')),
  html_content TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','completed','partial_failed','failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR(160) NOT NULL DEFAULT 'system',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_finops_email_campaigns_created
  ON {{FINOPS_SCHEMA}}.finops_email_campaigns (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.finops_email_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.finops_email_campaigns(id) ON DELETE CASCADE,
  source_user_id BIGINT NOT NULL,
  email VARCHAR(255) NOT NULL,
  status VARCHAR(35) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped_unsubscribed','skipped_whitelist','skipped_inactive','skipped_invalid')),
  error_message TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, source_user_id)
);
CREATE INDEX IF NOT EXISTS idx_finops_email_recipients_campaign
  ON {{FINOPS_SCHEMA}}.finops_email_recipients (campaign_id, status);

COMMENT ON TABLE {{FINOPS_SCHEMA}}.finops_email_settings IS
  'FinOps-owned SMTP settings. Credentials are encrypted and are independent of Sub2API SMTP settings.';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.finops_email_preferences IS
  'FinOps-only subscription preferences; changes do not affect Sub2API system notifications.';
