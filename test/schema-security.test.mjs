import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('CNY accounting migration contains no legacy or inferred upstream cost fields', () => {
  assert.equal(existsSync(new URL('../migrations/002_dual_ledger.sql', import.meta.url)), false);
  const initial = read('migrations/001_init.sql');
  const accounting = read('migrations/002_cny_accounting.sql');
  assert.doesNotMatch(initial, /CREATE SCHEMA/i);
  assert.match(accounting, /standard_cost_usd_reference/);
  assert.match(accounting, /user_charge_cny/);
  assert.doesNotMatch(accounting, /usd_credit|estimated_upstream_cost/i);
  assert.doesNotMatch(initial, /^\s*(?:standard_cost|user_charge|estimated_upstream_cost)\s+NUMERIC/im);
});

test('database constraints keep manual costs and cash entries in CNY', () => {
  const accounting = read('migrations/002_cny_accounting.sql');
  assert.match(accounting, /cost_profiles_currency_cny CHECK \(currency = 'CNY'\)/);
  assert.match(accounting, /account_cost_periods_original_currency_cny CHECK \(original_currency = 'CNY'\)/);
  assert.match(accounting, /account_cost_periods_fx_rate_one CHECK \(fx_rate = 1\)/);
  assert.match(accounting, /account_cost_periods_base_amount_matches CHECK \(base_amount = original_amount\)/);
  assert.match(accounting, /cash_transactions_manual_cny CHECK \(\s*source_table <> 'manual'\s*OR \(original_currency = 'CNY' AND fx_rate = 1 AND base_amount = original_amount\)/s);
});

test('wallet reconciliation migration stores snapshot deltas without source-table writes', () => {
  const reconciliation = read('migrations/003_reconciliation_snapshots.sql');
  assert.match(reconciliation, /CREATE TABLE IF NOT EXISTS .*wallet_reconciliation_snapshots/s);
  assert.match(reconciliation, /source_balance_cny NUMERIC/);
  assert.match(reconciliation, /ledger_activity_cny NUMERIC/);
  assert.doesNotMatch(reconciliation, /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\./i);
});

test('migrator refuses legacy or populated ledgers before applying CNY accounting', () => {
  const migrator = read('scripts/migrate.mjs');
  assert.match(migrator, /assertDistinctDatabases/);
  assert.match(migrator, /SELECT 1 FROM pg_namespace WHERE nspname = \$1/);
  assert.match(migrator, /does not exist; create it with an administrator-owned deployment grant/);
  assert.doesNotMatch(migrator, /CREATE SCHEMA IF NOT EXISTS/);
  assert.match(migrator, /version === '002_cny_accounting'/);
  assert.match(migrator, /version='002_dual_ledger'/);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*fact_usage_events\)/s);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*fact_usage_daily\)/s);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*cash_transactions\)/s);
});

test('database grants keep the sub2api source role read-only and target database separate', () => {
  const grants = read('deploy/postgres-grants.sql');
  const target = read('deploy/postgres-finops-target.sql');
  assert.match(grants, /CREATE ROLE finops_source_reader/i);
  assert.match(grants, /REVOKE SELECT \(key,value\) ON TABLE public\.settings FROM finops_source_reader/i);
  assert.doesNotMatch(grants, /GRANT SELECT \(key,value\) ON TABLE public\.settings/i);
  assert.doesNotMatch(grants, /CREATE\s+(?:SCHEMA|OR REPLACE VIEW)/i);
  assert.match(grants, /REVOKE CREATE ON SCHEMA public FROM finops_source_reader/i);
  assert.match(grants, /GRANT SELECT ON finops_source\.balance_recharge_multiplier TO finops_source_reader/i);
  assert.match(target, /CREATE ROLE finops_target_writer/i);
  assert.match(target, /CREATE SCHEMA IF NOT EXISTS finops AUTHORIZATION finops_target_writer/i);
});

test('cost accounting migration keeps fixed periods visible without a profile and never writes source tables', () => {
  const migration = read('migrations/004_cost_accounting_v2.sql');
  assert.match(migration, /WHEN fixed_period\.id IS NOT NULL THEN 'fixed_purchase'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*upstream_billing_snapshots/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\./i);
  assert.doesNotMatch(migration, /credentials/i);
});

test('group monitoring migration remains isolated to the FinOps schema', () => {
  const migration = read('migrations/006_group_monitoring.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*monitor_groups/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*monitor_group_observations/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /sub2api\.(?:groups|accounts|settings)/i);
});

test('source group catalog migration remains FinOps-owned', () => {
  const migration = read('migrations/007_source_group_catalog.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*source_group_catalog/s);
  assert.match(migration, /source_group_id BIGINT/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /credentials|model_routing/i);
});

test('monitor settings migration remains FinOps-owned and excludes account pool data', () => {
  const migration = read('migrations/008_monitor_settings.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*monitor_settings/s);
  assert.match(migration, /refresh_interval_seconds INTEGER/);
  assert.match(migration, /observation_source VARCHAR/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /account_count|account pool/i);
});

test('monitor PING latency migration remains FinOps-owned', () => {
  const migration = read('migrations/009_monitor_ping_latency.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS average_ping_latency_ms INTEGER/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /credentials|api_key/i);
});

test('multiplier history migration remains FinOps-owned and keeps open facts explicitly scoped', () => {
  const migration = read('migrations/010_multiplier_effective_history.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*group_selling_rate_rules/s);
  assert.match(migration, /selling_rate_rule_id BIGINT/);
  assert.match(migration, /finalized BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /sub2api\.(?:groups|accounts|settings)|credentials/i);
});

test('current-day multiplier rule backfill remains FinOps-owned and uses the configured timezone template', () => {
  const migration = read('migrations/011_backfill_current_day_multiplier_rules.sql');
  const migrator = read('scripts/migrate.mjs');
  assert.match(migration, /first_today_multiplier_rule/);
  assert.match(migration, /\{\{FINOPS_TIMEZONE\}\}/);
  assert.match(migration, /UPDATE \{\{FINOPS_SCHEMA\}\}\.account_cost_rules/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /sub2api\.(?:groups|accounts|settings)|credentials/i);
  assert.match(migrator, /replaceAll\('\{\{FINOPS_TIMEZONE\}\}', sqlLiteral\(config\.timezone\)\)/);
});

test('cost archives and audited historical repricing remain FinOps-owned', () => {
  const archives = read('migrations/012_cost_rule_archiving.sql');
  const repricing = read('migrations/013_audited_cost_repricing.sql');
  assert.match(archives, /CREATE TABLE IF NOT EXISTS .*account_cost_archives/s);
  assert.match(archives, /change_strategy IN \('future_only','current_day'\)/);
  assert.match(repricing, /CREATE TABLE IF NOT EXISTS .*account_cost_reprice_jobs/s);
  assert.match(repricing, /last_reprice_job_id BIGINT/);
  for (const migration of [archives, repricing]) {
    assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
    assert.doesNotMatch(migration, /sub2api\.(?:groups|accounts|settings)|credentials/i);
  }
});

test('immutable cost snapshot migration is isolated from sub2api and preserves unpriced history', () => {
  const migration = read('migrations/005_cost_snapshot_ledger.sql');
  const sync = read('src/services/sync-service.mjs');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*account_rate_observations/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*account_daily_snapshots/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*fact_usage_cost_snapshots/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*account_cost_daily_snapshots/s);
  assert.match(migration, /ALTER COLUMN account_rate_multiplier DROP NOT NULL/);
  assert.match(migration, /calculated_cost_cny NUMERIC/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\./i);
  assert.doesNotMatch(migration, /credentials/i);
  assert.match(sync, /ON CONFLICT\(source_usage_id\) DO NOTHING/);
  assert.match(sync, /ON CONFLICT\(source_account_id,observation_key\) DO NOTHING/);
  assert.match(sync, /account_rate_multiplier,?/);
  assert.doesNotMatch(sync, /COALESCE\(account_rate_multiplier,1\)/);
});

test('canonical model migration rebuilds only FinOps usage aggregates', () => {
  const migration = read('migrations/015_canonical_usage_models.sql');
  assert.match(migration, /DELETE FROM \{\{FINOPS_SCHEMA\}\}\.fact_usage_daily/);
  assert.match(migration, /INSERT INTO \{\{FINOPS_SCHEMA\}\}\.fact_usage_daily/);
  assert.match(migration, /FROM \{\{FINOPS_SCHEMA\}\}\.fact_usage_events/);
  assert.match(migration, /NULLIF\(BTRIM\(requested_model\),''\)/);
  assert.match(migration, /NULLIF\(BTRIM\(upstream_model\),''\)/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\./i);
  assert.doesNotMatch(migration, /sub2api\.(?:usage_logs|accounts|settings)|credentials/i);
});

test('supplier monitoring migration stores only FinOps-owned encrypted portal state', () => {
  const migration = read('migrations/016_supplier_monitoring.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_connections/s);
  assert.match(migration, /credentials_ciphertext TEXT NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_keys/s);
  assert.match(migration, /masked_key VARCHAR/);
  assert.match(migration, /key_fingerprint VARCHAR/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_alert_events/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+public\./i);
  assert.doesNotMatch(migration, /\braw_key\b|\bapi_key\s+(?:TEXT|VARCHAR)/i);
});

test('supplier key cost rules remain FinOps-owned and reference only sanitized key inventory', () => {
  const migration = read('migrations/017_supplier_key_cost_rules.sql');
  assert.match(migration, /ALTER TABLE .*account_cost_rules/s);
  assert.match(migration, /supplier_key_id BIGINT/);
  assert.match(migration, /REFERENCES .*supplier_keys\(id\)/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /credentials|raw_key|api_key\s+(?:TEXT|VARCHAR)/i);
});

test('supplier key link backfill updates only FinOps dimensions and cost rules', () => {
  const migration = read('migrations/018_backfill_supplier_key_cost_links.sql');
  assert.match(migration, /\{\{FINOPS_SCHEMA\}\}\.supplier_account_links/);
  assert.match(migration, /\{\{FINOPS_SCHEMA\}\}\.dim_accounts/);
  assert.match(migration, /\{\{FINOPS_SCHEMA\}\}\.account_cost_rules/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /credentials|raw_key|api_key\s+(?:TEXT|VARCHAR)/i);
});

test('supplier quality monitoring remains FinOps-owned and never stores plaintext keys', () => {
  const migration = read('migrations/020_supplier_quality_monitoring.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_quality_targets/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_quality_observations/s);
  assert.match(migration, /source_kind IN \('passive_usage','passive_monitor','active_probe'\)/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\braw_key\b|\bapi_key\s+(?:TEXT|VARCHAR)|credentials_ciphertext/i);
});

test('QQ alert delivery remains FinOps-owned and stores only encrypted gateway tokens', () => {
  const migration = read('migrations/021_qq_alert_notifications.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*alert_notification_settings/s);
  assert.match(migration, /access_token_ciphertext TEXT NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_alert_deliveries/s);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\bqq_password\b|\baccess_token\s+(?:TEXT|VARCHAR)/i);
});

test('profit guard threshold migration remains FinOps-owned', () => {
  const migration = read('migrations/026_profit_guard_threshold_modes.sql');
  assert.match(migration, /account_profit_guard_policies/);
  assert.match(migration, /minimum_sale_multiplier/);
  assert.doesNotMatch(migration, /\b(?:public|sub2api)\./i);
});

test('supplier profit guard defaults remain FinOps-owned', () => {
  const migration = read('migrations/029_supplier_profit_guard_defaults.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*supplier_profit_guard_defaults/s);
  assert.match(migration, /connection_id BIGINT PRIMARY KEY/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
});

test('Sub2API service authentication remains FinOps-owned and stores no plaintext credentials or token', () => {
  const migration = read('migrations/027_sub2api_service_auth.sql');
  const apiKeyMode = read('migrations/028_sub2api_service_auth_api_key.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*sub2api_service_auth_settings/s);
  assert.match(migration, /credentials_ciphertext TEXT NOT NULL/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\b(?:password|access_token|refresh_token)\s+(?:TEXT|VARCHAR)/i);
  assert.match(apiKeyMode, /auth_mode VARCHAR\(20\)/);
  assert.doesNotMatch(apiKeyMode, /\b(?:public|sub2api)\.[A-Za-z_]/i);
  assert.doesNotMatch(apiKeyMode, /\bapi_key\s+(?:TEXT|VARCHAR)/i);
});

test('OAuth Supply authentication remains FinOps-owned and stores only encrypted secrets', () => {
  const migration = read('migrations/031_oauth_supply_auth.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*oauth_supply_auth_settings/s);
  assert.match(migration, /credentials_ciphertext TEXT NOT NULL/);
  assert.match(migration, /token_ciphertext TEXT NOT NULL/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\b(?:password|access_token|refresh_token|token)\s+(?:TEXT|VARCHAR)/i);
});

test('OAuth Supply replenishment remains FinOps-owned and keeps account credentials encrypted', () => {
  const migration = read('migrations/032_oauth_supply_replenishment.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*oauth_supply_orders/s);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*oauth_supply_order_items/s);
  assert.match(migration, /credential_ciphertext TEXT NOT NULL/);
  assert.match(migration, /cost_ledger_status VARCHAR/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\b(?:access_token|refresh_token|password)\s+(?:TEXT|VARCHAR)/i);
});

test('custom account cost rule timing remains FinOps-owned', () => {
  const migration = read('migrations/052_custom_account_cost_rule_time.sql');
  assert.match(migration, /account_cost_rules_change_strategy_v52/);
  assert.match(migration, /'custom_time'/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /credentials|redis/i);
});

test('replenishment model whitelist remains FinOps-owned', () => {
  const migration = read('migrations/038_replenishment_model_whitelist.sql');
  assert.match(migration, /ALTER TABLE .*replenishment_rules/s);
  assert.match(migration, /model_whitelist TEXT\[\]/);
  assert.doesNotMatch(migration, /\b(?:public|sub2api)\./i);
});

test('replenishment inventory and recovery state remains FinOps-owned and encrypted', () => {
  const migration = read('migrations/033_replenishment_inventory_recovery.sql');
  assert.match(migration, /target_available_accounts INTEGER/);
  assert.match(migration, /quota_used_threshold_percent NUMERIC/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*replenishment_recoveries/s);
  assert.match(migration, /claim_url_ciphertext TEXT NOT NULL/);
  assert.match(migration, /credential_ciphertext TEXT NOT NULL/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\b(?:access_token|refresh_token|password|claim_url)\s+(?:TEXT|VARCHAR)/i);
});

test('replenishment lifecycle deletion remains FinOps-owned and preserves history', () => {
  const migration = read('migrations/034_replenishment_lifecycle.sql');
  assert.match(migration, /ALTER TABLE .*replenishment_rules[\s\S]*deleted_at TIMESTAMPTZ/);
  assert.match(migration, /ALTER TABLE .*oauth_supply_product_mappings[\s\S]*deleted_at TIMESTAMPTZ/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
});

test('replenishment execution logs and unlimited retries remain FinOps-owned', () => {
  const migration = read('migrations/035_replenishment_execution_logs.sql');
  assert.match(migration, /replenishment_events[\s\S]*rule_id BIGINT/);
  assert.match(migration, /recovery_retry_limit DROP NOT NULL/);
  assert.match(migration, /recovery_retry_limit IS NULL/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
});

test('supplier rotating token authentication keeps both tokens inside encrypted FinOps credentials', () => {
  const migration = read('migrations/036_supplier_refresh_token_auth.sql');
  assert.match(migration, /supplier_connections/);
  assert.match(migration, /token_refresh/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /\b(?:access_token|refresh_token)\s+(?:TEXT|VARCHAR)/i);
});

test('replenishment schedules and recovery policies remain FinOps-owned', () => {
  const migration = read('migrations/037_replenishment_scheduling_recovery_policies.sql');
  assert.match(migration, /schedule_interval_seconds INTEGER/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS .*replenishment_recovery_policies/s);
  assert.match(migration, /import_attempt_count INTEGER/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
});

test('replenishment trigger strategies remain FinOps-owned and constrained', () => {
  const migration = read('migrations/053_replenishment_trigger_strategy.sql');
  assert.match(migration, /ALTER TABLE \{\{FINOPS_SCHEMA\}\}\.replenishment_rules/);
  assert.match(migration, /trigger_strategy VARCHAR\(32\) NOT NULL DEFAULT 'inventory_threshold'/);
  assert.match(migration, /CHECK \(trigger_strategy IN \('inventory_threshold','fixed_schedule'\)\)/);
  assert.doesNotMatch(migration, /sub2api/i);
});

test('usage cost snapshot performance indexes remain FinOps-owned', () => {
  const migration = read('migrations/022_usage_cost_snapshot_performance.sql');
  assert.match(migration, /idx_finops_rate_observations_account_effective_time/);
  assert.match(migration, /idx_finops_rate_observations_supplier_effective_time/);
  assert.match(migration, /GREATEST\(/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE)\s+(?:public|sub2api)\./i);
  assert.doesNotMatch(migration, /credentials|raw_key|api_key\s+(?:TEXT|VARCHAR)/i);
});
