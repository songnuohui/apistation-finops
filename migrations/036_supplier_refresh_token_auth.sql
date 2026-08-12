-- ApiStation FinOps v0.36: encrypted rotating token pairs for Sub2API suppliers.
-- Access and refresh tokens remain inside the existing encrypted credential blob.

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  DROP CONSTRAINT IF EXISTS supplier_connections_auth_mode_check;

ALTER TABLE {{FINOPS_SCHEMA}}.supplier_connections
  ADD CONSTRAINT supplier_connections_auth_mode_check
  CHECK (auth_mode IN ('password','access_token','token_refresh','api_key'));

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.supplier_connections.auth_mode IS
  'password, static access_token, encrypted rotating token_refresh pair, or api_key';
