-- Track consecutive source-wallet and FinOps-ledger snapshots.
-- The first snapshot establishes a baseline; later runs compare deltas so
-- existing source balances do not need to be reconstructed from old history.

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.wallet_reconciliation_snapshots (
  source_user_id BIGINT PRIMARY KEY,
  source_balance_cny NUMERIC(20,10) NOT NULL,
  ledger_activity_cny NUMERIC(20,10) NOT NULL,
  last_difference_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'baseline',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_wallet_reconciliation_status
  ON {{FINOPS_SCHEMA}}.wallet_reconciliation_snapshots (status, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_finops_reconciliation_runs_type_time
  ON {{FINOPS_SCHEMA}}.reconciliation_runs (reconciliation_type, started_at DESC);
