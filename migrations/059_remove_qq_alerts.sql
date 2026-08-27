-- ApiStation FinOps v0.59: remove the retired QQ/OneBot alert delivery state.

DROP TABLE IF EXISTS {{FINOPS_SCHEMA}}.supplier_alert_deliveries;
DROP TABLE IF EXISTS {{FINOPS_SCHEMA}}.alert_notification_settings;
