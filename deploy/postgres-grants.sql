-- Run as a PostgreSQL administrator after changing the password.
-- ApiStation source data remains read-only; the same role owns only the finops schema.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finops_app') THEN
    CREATE ROLE finops_app LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sub2api TO finops_app;
GRANT USAGE ON SCHEMA public TO finops_app;

-- Never grant table-level SELECT here: accounts.credentials contains API/OAuth secrets.
REVOKE ALL ON TABLE public.users, public.accounts, public.usage_logs, public.payment_orders,
  public.redeem_codes, public.user_affiliate_ledger, public.payment_audit_logs,
  public.user_subscriptions, public.settings FROM finops_app;
-- Also remove the column-level grant used by an earlier draft of this script.
REVOKE SELECT (key,value) ON TABLE public.settings FROM finops_app;

GRANT SELECT (id,email,username,status,balance,total_recharged,updated_at,deleted_at)
  ON TABLE public.users TO finops_app;
GRANT SELECT (id,name,platform,type,status,expires_at,updated_at,deleted_at)
  ON TABLE public.accounts TO finops_app;
GRANT SELECT (
  id,user_id,api_key_id,account_id,request_id,model,requested_model,upstream_model,channel_id,group_id,
  subscription_id,billing_mode,billing_type,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
  total_cost,actual_cost,rate_multiplier,account_rate_multiplier,duration_ms,first_token_ms,created_at
) ON TABLE public.usage_logs TO finops_app;
GRANT SELECT (
  id,user_id,pay_amount,amount,provider_snapshot,payment_type,order_type,plan_id,subscription_group_id,
  subscription_days,status,refund_amount,paid_at,refund_at,fee_rate,recharge_code,updated_at
) ON TABLE public.payment_orders TO finops_app;
GRANT SELECT (id,code,type,value,status,used_by,used_at,notes,created_at)
  ON TABLE public.redeem_codes TO finops_app;
GRANT SELECT (id,user_id,action,amount,source_user_id,source_order_id,created_at,updated_at)
  ON TABLE public.user_affiliate_ledger TO finops_app;
GRANT SELECT (id,order_id,action,detail,operator,created_at)
  ON TABLE public.payment_audit_logs TO finops_app;
GRANT SELECT (id,user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,updated_at,deleted_at)
  ON TABLE public.user_subscriptions TO finops_app;

-- public.settings contains SMTP passwords, captcha secrets and OAuth client
-- secrets. Expose only the single non-secret multiplier row through an
-- administrator-owned security-barrier view.
CREATE SCHEMA IF NOT EXISTS finops_source;
ALTER SCHEMA finops_source OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA finops_source FROM PUBLIC,finops_app;
CREATE OR REPLACE VIEW finops_source.balance_recharge_multiplier
  WITH (security_barrier = true) AS
  SELECT key,value FROM public.settings
  WHERE key='BALANCE_RECHARGE_MULTIPLIER';
ALTER VIEW finops_source.balance_recharge_multiplier OWNER TO CURRENT_USER;
REVOKE ALL ON finops_source.balance_recharge_multiplier FROM PUBLIC,finops_app;
GRANT USAGE ON SCHEMA finops_source TO finops_app;
GRANT SELECT ON finops_source.balance_recharge_multiplier TO finops_app;

CREATE SCHEMA IF NOT EXISTS finops AUTHORIZATION finops_app;
ALTER SCHEMA finops OWNER TO finops_app;
GRANT USAGE, CREATE ON SCHEMA finops TO finops_app;
