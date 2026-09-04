-- Run as a PostgreSQL administrator against the sub2api database.
-- This file grants FinOps read-only source access only. It does not create
-- schemas, tables, views or migrations in the sub2api database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finops_source_reader') THEN
    CREATE ROLE finops_source_reader LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING' NOINHERIT;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sub2api TO finops_source_reader;
REVOKE CREATE ON SCHEMA public FROM finops_source_reader;
REVOKE TEMPORARY ON DATABASE sub2api FROM finops_source_reader;
GRANT USAGE ON SCHEMA public TO finops_source_reader;

-- Never grant table-level SELECT: public.accounts.credentials contains API
-- and OAuth secrets. Explicit column grants expose only required fields.
REVOKE ALL ON TABLE public.users, public.accounts, public.usage_logs, public.payment_orders,
  public.redeem_codes, public.user_affiliate_ledger, public.payment_audit_logs,
  public.settings FROM finops_source_reader;
REVOKE SELECT (
  id,user_id,api_key_id,account_id,request_id,model,requested_model,upstream_model,
  upstream_response_model,upstream_model_mismatch,channel_id,group_id,
  billing_mode,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
  total_cost,actual_cost,rate_multiplier,account_rate_multiplier,duration_ms,first_token_ms,created_at
) ON TABLE public.usage_logs FROM finops_source_reader;
REVOKE SELECT (key,value) ON TABLE public.settings FROM finops_source_reader;

GRANT SELECT (id,email,username,status,balance,total_recharged,updated_at,deleted_at)
  ON TABLE public.users TO finops_source_reader;
GRANT SELECT (
  id,user_id,model,requested_model,upstream_model,upstream_response_model,
  upstream_model_mismatch,created_at
) ON TABLE public.usage_logs TO finops_source_reader;
GRANT SELECT (id,name,platform,type,status,expires_at,updated_at,deleted_at,extra)
  ON TABLE public.accounts TO finops_source_reader;
GRANT SELECT (
  id,user_id,pay_amount,amount,provider_snapshot,payment_type,order_type,status,refund_amount,
  paid_at,refund_at,fee_rate,recharge_code,updated_at
) ON TABLE public.payment_orders TO finops_source_reader;
GRANT SELECT (id,code,type,value,status,used_by,used_at,notes,created_at)
  ON TABLE public.redeem_codes TO finops_source_reader;
GRANT SELECT (id,user_id,action,amount,source_user_id,source_order_id,created_at,updated_at)
  ON TABLE public.user_affiliate_ledger TO finops_source_reader;
GRANT SELECT (id,order_id,action,detail,operator,created_at)
  ON TABLE public.payment_audit_logs TO finops_source_reader;

-- Channel monitoring is read through a separate read-only connection. Grant
-- only the columns needed for status, recent history, and daily statistics;
-- never expose channel_monitors.api_key_encrypted.
DO $$
BEGIN
  IF to_regclass('public.channel_monitors') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.channel_monitors FROM finops_source_reader';
    EXECUTE 'GRANT SELECT (id,name,provider,group_name,primary_model,enabled,last_checked_at) ON TABLE public.channel_monitors TO finops_source_reader';
  END IF;
  IF to_regclass('public.channel_monitor_histories') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.channel_monitor_histories FROM finops_source_reader';
    EXECUTE 'GRANT SELECT (id,monitor_id,model,status,latency_ms,ping_latency_ms,checked_at) ON TABLE public.channel_monitor_histories TO finops_source_reader';
  END IF;
  IF to_regclass('public.channel_monitor_daily_rollups') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.channel_monitor_daily_rollups FROM finops_source_reader';
    EXECUTE 'GRANT SELECT (id,monitor_id,model,bucket_date,total_checks,ok_count,sum_latency_ms,count_latency,sum_ping_latency_ms,count_ping_latency) ON TABLE public.channel_monitor_daily_rollups TO finops_source_reader';
  END IF;
END
$$;

-- Optional compatibility grants. They are applied only when the source
-- instance actually exposes the subscription-related columns and table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='usage_logs'
      AND column_name IN ('subscription_id','billing_type')
    GROUP BY table_schema,table_name HAVING COUNT(*)=2
  ) THEN
    EXECUTE 'REVOKE SELECT (subscription_id,billing_type) ON TABLE public.usage_logs FROM finops_source_reader';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payment_orders'
      AND column_name IN ('plan_id','subscription_group_id','subscription_days')
    GROUP BY table_schema,table_name HAVING COUNT(*)=3
  ) THEN
    EXECUTE 'GRANT SELECT (plan_id,subscription_group_id,subscription_days) ON TABLE public.payment_orders TO finops_source_reader';
  END IF;

  IF to_regclass('public.user_subscriptions') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.user_subscriptions FROM finops_source_reader';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='user_subscriptions'
        AND column_name IN (
          'id','user_id','group_id','starts_at','expires_at','status',
          'daily_usage_usd','weekly_usage_usd','monthly_usage_usd','updated_at','deleted_at'
        )
      GROUP BY table_schema,table_name HAVING COUNT(*)=11
    ) THEN
      EXECUTE 'GRANT SELECT (id,user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,updated_at,deleted_at) ON TABLE public.user_subscriptions TO finops_source_reader';
    END IF;
  END IF;
END
$$;

-- public.settings contains credentials. The existing administrator-owned,
-- security-barrier view exposes only the one non-secret multiplier row.
REVOKE ALL ON SCHEMA finops_source FROM PUBLIC,finops_source_reader;
REVOKE ALL ON finops_source.balance_recharge_multiplier FROM PUBLIC,finops_source_reader;
GRANT USAGE ON SCHEMA finops_source TO finops_source_reader;
GRANT SELECT ON finops_source.balance_recharge_multiplier TO finops_source_reader;
