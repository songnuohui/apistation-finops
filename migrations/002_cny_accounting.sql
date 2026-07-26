-- ApiStation FinOps v0.3: CNY operating ledger with USD Token reference fields.
-- This migration is for clean installations only. It never changes ApiStation
-- source tables and must not be used to relabel a legacy USD Credit ledger.

ALTER TABLE {{FINOPS_SCHEMA}}.dim_users
  ADD COLUMN IF NOT EXISTS balance_currency VARCHAR(20) NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ;
ALTER TABLE {{FINOPS_SCHEMA}}.dim_users
  ADD CONSTRAINT dim_users_balance_currency_cny CHECK (balance_currency = 'CNY');

ALTER TABLE {{FINOPS_SCHEMA}}.dim_accounts
  ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ;

ALTER TABLE {{FINOPS_SCHEMA}}.cost_profiles
  ADD CONSTRAINT cost_profiles_currency_cny CHECK (currency = 'CNY');

ALTER TABLE {{FINOPS_SCHEMA}}.account_cost_periods
  ADD CONSTRAINT account_cost_periods_original_currency_cny CHECK (original_currency = 'CNY'),
  ADD CONSTRAINT account_cost_periods_fx_rate_one CHECK (fx_rate = 1),
  ADD CONSTRAINT account_cost_periods_base_amount_matches CHECK (base_amount = original_amount);

ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_events
  ADD COLUMN IF NOT EXISTS billing_type SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscription_id BIGINT,
  ADD COLUMN IF NOT EXISTS standard_cost_usd_reference NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS user_charge_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recognized_revenue_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_recognition_status VARCHAR(24) NOT NULL DEFAULT 'unallocated';

ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_daily
  ADD COLUMN IF NOT EXISTS billing_type SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_cost_usd_reference NUMERIC(24,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS user_charge_cny NUMERIC(24,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recognized_revenue_cny NUMERIC(24,10) NOT NULL DEFAULT 0;

DO $$
DECLARE
  target_table regclass := '{{FINOPS_SCHEMA}}.fact_usage_daily'::regclass;
  existing_primary_key TEXT;
BEGIN
  -- The initial migration used PostgreSQL's generated constraint name, but a
  -- manually restored database may have a different name. Drop whichever
  -- primary key is actually present before adding the billing_type dimension.
  SELECT conname INTO existing_primary_key
  FROM pg_constraint
  WHERE conrelid = target_table AND contype = 'p';

  IF existing_primary_key IS NOT NULL AND existing_primary_key <> 'fact_usage_daily_pkey_v2' THEN
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', target_table, existing_primary_key);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = target_table AND contype = 'p'
  ) THEN
    ALTER TABLE {{FINOPS_SCHEMA}}.fact_usage_daily
      ADD CONSTRAINT fact_usage_daily_pkey_v2 PRIMARY KEY
      (day, source_user_id, source_api_key_id, source_account_id, source_group_id, model, billing_mode, billing_type);
  END IF;
END $$;

ALTER TABLE {{FINOPS_SCHEMA}}.cash_transactions
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(24) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credited_currency VARCHAR(20) NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS source_status VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS refund_base_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_credit_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
ALTER TABLE {{FINOPS_SCHEMA}}.cash_transactions
  ADD CONSTRAINT cash_transactions_credited_currency_cny CHECK (credited_currency = 'CNY');
ALTER TABLE {{FINOPS_SCHEMA}}.cash_transactions
  ADD CONSTRAINT cash_transactions_manual_cny CHECK (
    source_table <> 'manual'
    OR (original_currency = 'CNY' AND fx_rate = 1 AND base_amount = original_amount)
  );

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.credit_events (
  id BIGSERIAL PRIMARY KEY,
  source_table VARCHAR(64) NOT NULL,
  source_id BIGINT NOT NULL,
  source_version VARCHAR(80) NOT NULL DEFAULT 'v1',
  source_user_id BIGINT NOT NULL DEFAULT 0,
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('recharge','refund','redeem','admin_adjustment','affiliate_rebate','usage','subscription','manual')),
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('in','out')),
  credit_amount NUMERIC(20,10) NOT NULL,
  credit_currency VARCHAR(20) NOT NULL DEFAULT 'CNY' CHECK (credit_currency = 'CNY'),
  cash_basis_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  original_amount NUMERIC(20,10) NOT NULL DEFAULT 0,
  original_currency VARCHAR(12) NOT NULL DEFAULT 'CNY',
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_table, source_id, source_version)
);

CREATE INDEX IF NOT EXISTS idx_finops_credit_events_user_time
  ON {{FINOPS_SCHEMA}}.credit_events (source_user_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_finops_credit_events_type_time
  ON {{FINOPS_SCHEMA}}.credit_events (event_type, occurred_at);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.credit_lots (
  id BIGSERIAL PRIMARY KEY,
  source_event_id BIGINT NOT NULL UNIQUE REFERENCES {{FINOPS_SCHEMA}}.credit_events(id) ON DELETE RESTRICT,
  source_user_id BIGINT NOT NULL,
  granted_credit NUMERIC(20,10) NOT NULL,
  remaining_credit NUMERIC(20,10) NOT NULL,
  cash_basis_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  credit_currency VARCHAR(20) NOT NULL DEFAULT 'CNY' CHECK (credit_currency = 'CNY'),
  acquired_at TIMESTAMPTZ NOT NULL,
  lot_type VARCHAR(24) NOT NULL DEFAULT 'paid',
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','exhausted','reversed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (granted_credit >= 0),
  CHECK (remaining_credit >= 0)
);

CREATE INDEX IF NOT EXISTS idx_finops_credit_lots_user_open
  ON {{FINOPS_SCHEMA}}.credit_lots (source_user_id, acquired_at, id)
  WHERE status = 'open' AND remaining_credit > 0;

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.revenue_recognition (
  id BIGSERIAL PRIMARY KEY,
  source_usage_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.fact_usage_events(source_usage_id) ON DELETE CASCADE,
  credit_lot_id BIGINT NOT NULL REFERENCES {{FINOPS_SCHEMA}}.credit_lots(id) ON DELETE RESTRICT,
  allocated_credit NUMERIC(20,10) NOT NULL,
  recognized_revenue_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  revenue_currency VARCHAR(20) NOT NULL DEFAULT 'CNY' CHECK (revenue_currency = 'CNY'),
  method VARCHAR(16) NOT NULL DEFAULT 'fifo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_usage_id, credit_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_finops_revenue_recognition_usage
  ON {{FINOPS_SCHEMA}}.revenue_recognition (source_usage_id);
CREATE INDEX IF NOT EXISTS idx_finops_revenue_recognition_lot
  ON {{FINOPS_SCHEMA}}.revenue_recognition (credit_lot_id);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.dim_subscriptions (
  source_subscription_id BIGINT PRIMARY KEY,
  source_user_id BIGINT NOT NULL DEFAULT 0,
  source_group_id BIGINT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status VARCHAR(24) NOT NULL DEFAULT '',
  daily_usage_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  weekly_usage_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  monthly_usage_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  source_deleted_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_subscriptions_user_time
  ON {{FINOPS_SCHEMA}}.dim_subscriptions (source_user_id, starts_at, expires_at);

CREATE TABLE IF NOT EXISTS {{FINOPS_SCHEMA}}.source_audit_events (
  source_audit_id BIGINT PRIMARY KEY,
  source_table VARCHAR(64) NOT NULL,
  source_object_id VARCHAR(64) NOT NULL DEFAULT '',
  action VARCHAR(80) NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  operator VARCHAR(120) NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finops_source_audit_time
  ON {{FINOPS_SCHEMA}}.source_audit_events (occurred_at DESC, source_audit_id DESC);

INSERT INTO {{FINOPS_SCHEMA}}.sync_cursors(source_name)
VALUES ('redeem_codes'), ('user_affiliate_ledger'), ('payment_audit_logs'), ('credit_reconciliation')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE {{FINOPS_SCHEMA}}.credit_events IS 'CNY 余额账本变动；cash_basis_cny 为可确认的人民币现金基础，赠送/返利为 0';
COMMENT ON TABLE {{FINOPS_SCHEMA}}.credit_lots IS '按 FIFO 追踪每次人民币余额入账的剩余金额与现金基础';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.fact_usage_events.standard_cost_usd_reference IS '模型目录 Token 标价参考（USD），不得进入人民币利润核算';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.fact_usage_events.user_charge_cny IS '用户实际扣除的人民币余额';
COMMENT ON COLUMN {{FINOPS_SCHEMA}}.fact_usage_events.recognized_revenue_cny IS '按消费的人民币余额批次确认的人民币经营收入';
