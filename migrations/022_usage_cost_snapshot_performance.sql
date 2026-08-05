-- ApiStation FinOps v0.22: indexes for request-level cost snapshot refresh.
-- This migration changes only the isolated FinOps database.

CREATE INDEX IF NOT EXISTS idx_finops_rate_observations_account_effective_time
  ON {{FINOPS_SCHEMA}}.account_rate_observations (
    source_account_id,
    GREATEST(
      COALESCE(observed_at, '-infinity'::timestamptz),
      COALESCE(received_at, '-infinity'::timestamptz),
      COALESCE(last_attempt_at, '-infinity'::timestamptz),
      COALESCE(captured_at, '-infinity'::timestamptz)
    ) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_finops_rate_observations_supplier_effective_time
  ON {{FINOPS_SCHEMA}}.account_rate_observations (
    source_account_id,
    supplier_key_id,
    GREATEST(
      COALESCE(observed_at, '-infinity'::timestamptz),
      COALESCE(received_at, '-infinity'::timestamptz),
      COALESCE(last_attempt_at, '-infinity'::timestamptz),
      COALESCE(captured_at, '-infinity'::timestamptz)
    ) DESC,
    id DESC
  )
  WHERE supplier_key_id IS NOT NULL;

COMMENT ON INDEX {{FINOPS_SCHEMA}}.idx_finops_rate_observations_account_effective_time IS
  'Supports latest effective upstream-rate lookup for each FinOps usage event.';
COMMENT ON INDEX {{FINOPS_SCHEMA}}.idx_finops_rate_observations_supplier_effective_time IS
  'Supports supplier-key-scoped upstream-rate lookup without scanning unrelated observations.';
