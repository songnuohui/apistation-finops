-- ApiStation FinOps v0.27: dedicated Sub2API service-account authentication.
-- Secrets are encrypted by FinOps before storage. Access tokens are memory-only.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.sub2api_service_auth_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email VARCHAR(255) NOT NULL DEFAULT '',
  credentials_ciphertext TEXT NOT NULL DEFAULT '',
  last_authenticated_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(120) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{FINOPS_SCHEMA}}.sub2api_service_auth_settings(id)
VALUES(1)
ON CONFLICT(id) DO NOTHING;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.sub2api_service_auth_settings IS
  'FinOps-owned dedicated Sub2API service account. Encrypted credentials only; access tokens remain in memory.';
