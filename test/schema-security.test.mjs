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
