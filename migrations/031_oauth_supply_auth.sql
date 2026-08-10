-- ApiStation FinOps v0.31: isolated OAuth Supply customer authentication.
-- Credentials and the customer token are encrypted by FinOps. No source or
-- Sub2API tables are touched by this integration.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.oauth_supply_auth_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  base_url VARCHAR(1000) NOT NULL DEFAULT 'https://sogouedu.cc',
  username VARCHAR(255) NOT NULL DEFAULT '',
  credentials_ciphertext TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL DEFAULT '',
  last_authenticated_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{FINOPS_SCHEMA}}.oauth_supply_auth_settings(id, base_url)
VALUES (1, 'https://sogouedu.cc')
ON CONFLICT(id) DO NOTHING;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.oauth_supply_auth_settings IS
  'FinOps-owned OAuth Supply customer login configuration. Secrets and tokens are encrypted.';
