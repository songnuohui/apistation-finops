-- ApiStation FinOps v0.15: make usage aggregates display the model that was
-- actually requested when the source log did not persist its primary model.
-- This rebuild touches only the independent FinOps aggregate table. It never
-- reads from or writes to a sub2api source table.

DELETE FROM {{FINOPS_SCHEMA}}.fact_usage_daily;

INSERT INTO {{FINOPS_SCHEMA}}.fact_usage_daily(
  day,source_user_id,source_api_key_id,source_account_id,source_group_id,model,billing_mode,billing_type,
  requests,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
  standard_cost_usd_reference,user_charge_cny,recognized_revenue_cny
)
SELECT
  (occurred_at AT TIME ZONE {{FINOPS_TIMEZONE}})::date,
  source_user_id,source_api_key_id,source_account_id,source_group_id,
  COALESCE(NULLIF(BTRIM(model),''),NULLIF(BTRIM(requested_model),''),
    NULLIF(BTRIM(upstream_model),''),'未标注模型'),
  billing_mode,billing_type,
  COUNT(*),SUM(input_tokens),SUM(output_tokens),SUM(cache_creation_tokens),SUM(cache_read_tokens),
  SUM(standard_cost_usd_reference),SUM(user_charge_cny),SUM(recognized_revenue_cny)
FROM {{FINOPS_SCHEMA}}.fact_usage_events
GROUP BY
  (occurred_at AT TIME ZONE {{FINOPS_TIMEZONE}})::date,
  source_user_id,source_api_key_id,source_account_id,source_group_id,
  COALESCE(NULLIF(BTRIM(model),''),NULLIF(BTRIM(requested_model),''),
    NULLIF(BTRIM(upstream_model),''),'未标注模型'),
  billing_mode,billing_type;
