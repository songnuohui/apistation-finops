-- ApiStation FinOps v0.28: support an administrator API Key as the preferred
-- machine credential for Sub2API. The key remains encrypted in FinOps only.

ALTER TABLE {{FINOPS_SCHEMA}}.sub2api_service_auth_settings
  ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(20) NOT NULL DEFAULT 'password';

ALTER TABLE {{FINOPS_SCHEMA}}.sub2api_service_auth_settings
  ADD CONSTRAINT sub2api_service_auth_mode CHECK (auth_mode IN ('password','api_key'));

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.sub2api_service_auth_settings.auth_mode IS
  'password uses a dedicated administrator login; api_key uses the administrator X-API-Key header.';
