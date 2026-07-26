import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('CNY accounting migration contains no legacy or inferred upstream cost fields', () => {
  assert.equal(existsSync(new URL('../migrations/002_dual_ledger.sql', import.meta.url)), false);
  const initial = read('migrations/001_init.sql');
  const accounting = read('migrations/002_cny_accounting.sql');
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

test('migrator refuses legacy or populated ledgers before applying CNY accounting', () => {
  const migrator = read('scripts/migrate.mjs');
  assert.match(migrator, /version === '002_cny_accounting'/);
  assert.match(migrator, /version='002_dual_ledger'/);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*fact_usage_events\)/s);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*fact_usage_daily\)/s);
  assert.match(migrator, /EXISTS\(SELECT 1 FROM .*cash_transactions\)/s);
});

test('database grants expose only the restricted balance multiplier view', () => {
  const grants = read('deploy/postgres-grants.sql');
  assert.match(grants, /REVOKE SELECT \(key,value\) ON TABLE public\.settings FROM finops_app/i);
  assert.doesNotMatch(grants, /GRANT SELECT \(key,value\) ON TABLE public\.settings/i);
  assert.match(grants, /CREATE OR REPLACE VIEW finops_source\.balance_recharge_multiplier\s+WITH \(security_barrier = true\).*WHERE key='BALANCE_RECHARGE_MULTIPLIER'/is);
  assert.match(grants, /REVOKE ALL ON SCHEMA finops_source FROM PUBLIC,finops_app/i);
  assert.match(grants, /GRANT SELECT ON finops_source\.balance_recharge_multiplier TO finops_app/i);
});
