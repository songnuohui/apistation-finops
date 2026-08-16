-- Cover the time-window aggregation paths used by the overview dashboard.
-- These indexes are confined to FinOps tables; source/Sub2API data is untouched.

CREATE INDEX IF NOT EXISTS idx_finops_usage_events_overview_time
  ON {{FINOPS_SCHEMA}}.fact_usage_events (occurred_at DESC)
  INCLUDE (input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
           source_user_id, source_account_id, duration_ms, user_charge_cny,
           standard_cost_usd_reference);

CREATE INDEX IF NOT EXISTS idx_finops_usage_cost_snapshots_overview_time
  ON {{FINOPS_SCHEMA}}.fact_usage_cost_snapshots (occurred_at DESC)
  INCLUDE (source_account_id, calculated_cost_cny, user_charge_cny, cost_status,
           cost_mode);

CREATE INDEX IF NOT EXISTS idx_finops_cash_overview_time
  ON {{FINOPS_SCHEMA}}.cash_transactions (occurred_at DESC)
  INCLUDE (base_amount, direction, transaction_type, status, order_type);

CREATE INDEX IF NOT EXISTS idx_finops_credit_events_overview_time
  ON {{FINOPS_SCHEMA}}.credit_events (occurred_at DESC)
  INCLUDE (credit_amount, direction, event_type, cash_basis_cny, source_user_id);
