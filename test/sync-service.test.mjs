import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSourceUnitContract, COST_SNAPSHOT_COLUMN_COUNT, MAX_USAGE_ROWS_PER_INSERT,
  REQUIRED_SOURCE_COLUMNS,
  refundCashAmount, summarizeChannelMonitorGroup, SyncService, USAGE_COLUMN_COUNT,
  USAGE_COST_SNAPSHOT_OPEN_DAYS,
} from '../src/services/sync-service.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  assertDistinctDatabases, createFinopsPool, createSourcePool,
} from '../src/db.mjs';

test('cash refund uses the paid-to-credited ratio', () => {
  assert.equal(refundCashAmount('100', '88', '25').toFixed(2), '22.00');
  assert.equal(refundCashAmount('100', '88', '100').toFixed(2), '88.00');
});

test('cash refund rounds to payment currency precision and rejects invalid totals', () => {
  assert.equal(refundCashAmount('100', '103', '33.33').toFixed(2), '34.33');
  assert.equal(refundCashAmount('0', '103', '10').toFixed(2), '0.00');
  assert.equal(refundCashAmount('100', '0', '10').toFixed(2), '0.00');
});

test('large usage batches stay below PostgreSQL bind parameter limits', () => {
  assert.ok(MAX_USAGE_ROWS_PER_INSERT > 0);
  assert.ok(MAX_USAGE_ROWS_PER_INSERT * USAGE_COLUMN_COUNT <= 65000);
  assert.equal(USAGE_COST_SNAPSHOT_OPEN_DAYS, 1);
});

test('CNY source-unit contract rejects accidental USD accounting before any sync query', async () => {
  assert.equal(assertSourceUnitContract({}), 'CNY');
  assert.throws(() => assertSourceUnitContract({ sourceBalanceUnit: 'USD' }), /requires canonical CNY source amounts/);
  const service = new SyncService({ query: async () => assert.fail('runOnce must reject before querying') }, {
    finopsSchema: 'finops', sourceSchema: 'public', sourceBalanceUnit: 'USD',
  });
  await assert.rejects(service.runOnce(), /requires canonical CNY source amounts/);
});

test('configuration rejects legacy automatic USD-to-CNY conversion', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', UPSTREAM_USD_TO_CNY_RATE: '7.2' }),
    /no longer supported/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', SOURCE_BALANCE_UNIT: 'USD' }),
    /SOURCE_BALANCE_UNIT must be CNY/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', DATABASE_URL: 'postgres://legacy' }),
    /no longer supported/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true', SOURCE_DATABASE_URL: 'postgres://source' }),
    /must be configured together/,
  );
});

test('runtime refresh shares an in-flight source read and respects the live refresh cooldown', async () => {
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', sourceBalanceUnit: 'CNY',
  });
  let calls = 0;
  service.refreshRuntimeSnapshotsUnsafe = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 7;
  };

  const [first, second] = await Promise.all([
    service.refreshRuntimeSnapshots({ minIntervalMs: 2_000 }),
    service.refreshRuntimeSnapshots({ minIntervalMs: 2_000 }),
  ]);

  assert.equal(first, 7);
  assert.equal(second, 7);
  assert.equal(calls, 1);
  assert.equal(await service.refreshRuntimeSnapshots({ minIntervalMs: 2_000 }), 0);
});

test('channel monitor summaries use operational and degraded checks as available', () => {
  assert.deepEqual(summarizeChannelMonitorGroup([
    { enabled: true, primaryStatus: 'operational', availability7d: 99.5, primaryLatencyMs: 120, primaryPingLatencyMs: 5 },
    { enabled: true, primaryStatus: 'degraded', availability7d: 98.5, primaryLatencyMs: 180, primaryPingLatencyMs: 7 },
    { enabled: false, primaryStatus: 'failed', availability7d: 0, primaryLatencyMs: 999, primaryPingLatencyMs: 999 },
  ]), {
    status: 'degraded',
    availableCount: 2,
    totalCount: 2,
    availabilityPercent: 99,
    averageLatencyMs: 150,
    averagePingLatencyMs: 6,
  });
  assert.equal(summarizeChannelMonitorGroup([{ enabled: true, primaryStatus: 'failed' }]).status, 'unavailable');
  assert.equal(summarizeChannelMonitorGroup([{ enabled: true }]).status, 'unknown');
});

test('database isolation rejects source and FinOps connections to the same database', async () => {
  await assert.rejects(
    assertDistinctDatabases(
      { query: async () => ({ rows: [{ database_name: 'sub2api', role_name: 'reader' }] }) },
      { query: async () => ({ rows: [{ database_name: 'sub2api', role_name: 'writer' }] }) },
    ),
    /isolation check failed/,
  );
  const result = await assertDistinctDatabases(
    { query: async () => ({ rows: [{ database_name: 'sub2api', role_name: 'reader' }] }) },
    { query: async () => ({ rows: [{ database_name: 'apistation_finops', role_name: 'writer' }] }) },
  );
  assert.equal(result.finops.database_name, 'apistation_finops');
});

test('source and FinOps pools keep independent statement timeout boundaries', async () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    AUTH_DISABLED: 'true',
    SOURCE_DATABASE_URL: 'postgres://source',
    FINOPS_DATABASE_URL: 'postgres://finops',
    SOURCE_DATABASE_POOL_MAX: '4',
    FINOPS_DATABASE_POOL_MAX: '9',
  });
  const sourcePool = createSourcePool(config);
  const finopsPool = createFinopsPool(config);
  try {
    assert.equal(config.sourceStatementTimeoutMs, 10_000);
    assert.equal(config.finopsStatementTimeoutMs, 30_000);
    assert.equal(sourcePool.options.statement_timeout, 10_000);
    assert.equal(finopsPool.options.statement_timeout, 30_000);
    assert.equal(sourcePool.options.max, 4);
    assert.equal(finopsPool.options.max, 9);
  } finally {
    await Promise.all([sourcePool.end(), finopsPool.end()]);
  }
});

test('user subscriptions are opt-in and not required for metered billing', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('information_schema.columns')) {
        return {
          rows: Object.entries(REQUIRED_SOURCE_COLUMNS)
            .filter(([table]) => table !== 'user_subscriptions')
            .flatMap(([table, columns]) => columns.map((column) => ({ table_name: table, column_name: column }))),
          rowCount: 1,
        };
      }
      if (text.includes("key='BALANCE_RECHARGE_MULTIPLIER'")) return { rows: [], rowCount: 0 };
      assert.fail(`unexpected query: ${text}`);
    },
  };
  const service = new SyncService(pool, {
    finopsSchema: 'finops', sourceSchema: 'public', sourceBalanceUnit: 'CNY',
  }, { warn() {}, error() {}, info() {} });

  await service.validateSourceSchema();

  assert.ok(!queries[0].params[1].includes('user_subscriptions'));
  assert.equal(loadConfig({ NODE_ENV: 'development', AUTH_DISABLED: 'true' }).subscriptionsEnabled, false);
});

function compatibleSourcePool(multiplier) {
  return {
    async query(text) {
      if (text.includes('information_schema.columns')) {
        return {
          rows: Object.entries(REQUIRED_SOURCE_COLUMNS).flatMap(([table, columns]) => (
            columns.map((column) => ({ table_name: table, column_name: column }))
          )),
          rowCount: 1,
        };
      }
      if (text.includes("key='BALANCE_RECHARGE_MULTIPLIER'")) {
        assert.match(text, /FROM "finops_source"\."balance_recharge_multiplier"/);
        return { rows: multiplier === undefined ? [] : [{ value: String(multiplier) }], rowCount: multiplier === undefined ? 0 : 1 };
      }
      assert.fail(`unexpected query: ${text}`);
    },
  };
}

test('missing recharge multiplier defaults to one', async () => {
  const service = new SyncService(compatibleSourcePool(undefined), {
    finopsSchema: 'finops', sourceSchema: 'public', sourceBalanceUnit: 'CNY',
  }, { warn: () => assert.fail('missing multiplier should not warn'), error() {}, info() {} });
  assert.deepEqual(await service.validateSourceSchema(), {
    sourceBalanceUnit: 'CNY', balanceRechargeMultiplier: 1, settingPresent: false,
  });
});

test('non-one recharge multiplier remains CNY and produces a warning', async () => {
  const warnings = [];
  const service = new SyncService(compatibleSourcePool('1.2'), {
    finopsSchema: 'finops', sourceSchema: 'public', sourceBalanceUnit: 'CNY',
  }, { warn: (...args) => warnings.push(args), error() {}, info() {} });
  assert.deepEqual(await service.validateSourceSchema(), {
    sourceBalanceUnit: 'CNY', balanceRechargeMultiplier: 1.2, settingPresent: true,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /bonus\/discount multiplier/);
});

test('dimension sync reads only the sanitized upstream billing probe and writes only FinOps tables', async () => {
  const sourceQueries = [];
  const finopsQueries = [];
  const sourcePool = {
    async query(text) {
      sourceQueries.push(text);
      if (text.includes('FROM "public".users')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "public".accounts')) {
        return {
          rows: [{
            id: 8, name: 'account-8', platform: 'OpenAI', type: 'seat', status: 'active',
            expires_at: null, deleted_at: null, updated_at: new Date('2026-07-31T00:00:00Z'),
            upstream_billing_probe: {
              status: 'ok',
              received_at: '2026-07-31T00:00:00Z',
              data: { effective_rate_multiplier: 0.8, credentials: 'must not be copied' },
            },
          }],
          rowCount: 1,
        };
      }
      assert.fail(`unexpected source query: ${text}`);
    },
  };
  const client = {
    async query(text, params = []) {
      finopsQueries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const service = new SyncService(
    sourcePool,
    { connect: async () => client },
    { finopsSchema: 'finops', sourceSchema: 'public' },
    { error() {}, warn() {} },
  );

  await service.syncDimensions();

  const accountQuery = sourceQueries.find((text) => text.includes('accounts'));
  assert.match(accountQuery, /extra->'upstream_billing_probe'/);
  assert.doesNotMatch(accountQuery, /credentials|SELECT \*/i);
  assert.ok(finopsQueries.some(({ text }) => text.includes('pg_advisory_xact_lock')));
  assert.ok(finopsQueries.some(({ text }) => text.includes('upstream_billing_snapshots')));
  assert.ok(finopsQueries.every(({ text }) => !/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*\bpublic\./i.test(text)));
});

test('upstream billing observations are sanitized and append-only', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO "finops".account_rate_observations')) {
        return { rows: [{ id: 51 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, { finopsSchema: 'finops', sourceSchema: 'public' });
  const result = await service.upsertUpstreamBillingSnapshot(client, 8, {
    status: 'ok',
    received_at: '2026-07-31T01:00:00Z',
    data: {
      effective_rate_multiplier: 0.8,
      group_rate_multiplier: 0.7,
      credentials: 'must not persist',
    },
    credentials: 'must not persist',
  });
  const observation = queries.find((query) => query.text.includes('account_rate_observations'));
  assert.equal(result.id, 51);
  assert.match(observation.text, /ON CONFLICT\(source_account_id,observation_key\) DO NOTHING/);
  const data = JSON.parse(observation.params.at(-1));
  assert.equal(data.effective_rate_multiplier, '0.8');
  assert.equal(data.credentials, undefined);
  assert.equal(observation.params.includes('must not persist'), false);
});

test('daily account snapshot records deletion and multiplier changes without inferring absent rows', async () => {
  const updates = [];
  const client = {
    async query(text, params = []) {
      if (text.includes('FROM "finops".account_daily_snapshots')) {
        return {
          rows: [{
            name: 'old-name', platform: 'OpenAI', account_type: 'seat', status: 'active',
            expires_at: null, source_deleted_at: null, is_available: true,
            rate_status: 'ok', effective_rate_multiplier: '0.8',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('UPDATE "finops".account_daily_snapshots')) updates.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'Asia/Shanghai',
  });
  await service.upsertAccountDailySnapshot(client, {
    id: 8, name: 'new-name', platform: 'OpenAI', type: 'seat', status: 'disabled',
    expires_at: null, deleted_at: new Date('2026-07-31T01:00:00Z'),
    updated_at: new Date('2026-07-31T01:00:00Z'),
  }, {
    id: 52,
    snapshot: { status: 'ok', effectiveRateMultiplier: '0.9' },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[9], false);
  assert.equal(updates[0].params[13], 1);
  assert.match(updates[0].text, /rate_change_count=rate_change_count\+\$14/);
});

test('cost snapshots prefer supplier-key history, then probes and request multipliers, while preserving unknown cost', async () => {
  const queries = [];
  let selected = false;
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO "finops".fact_usage_cost_snapshots')) {
        return { rows: [], rowCount: params.length / COST_SNAPSHOT_COLUMN_COUNT };
      }
      if (text.includes('FROM "finops".fact_usage_events f')) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return {
          rows: [
            {
              source_usage_id: 1, source_account_id: 8, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T01:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: '0.5',
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: 7, account_cost_rule_id: null, fixed_period_id: null,
              rate_observation_id: 41, observation_status: 'ok', observation_source_kind: 'sub2api_snapshot',
              observation_fresh_until: new Date('2026-07-31T01:30:00Z'), observed_resolved_multiplier: '0.8',
              observed_upstream_multiplier: '0.8', observed_peak_enabled: false,
            },
            {
              source_usage_id: 2, source_account_id: 8, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T02:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: null,
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: 7, account_cost_rule_id: null, fixed_period_id: null,
              rate_observation_id: 41, observation_status: 'ok', observation_source_kind: 'sub2api_snapshot',
              observation_fresh_until: new Date('2026-07-31T02:30:00Z'), observed_resolved_multiplier: '0.8',
              observed_upstream_multiplier: '0.8', observed_peak_enabled: false,
            },
            {
              source_usage_id: 3, source_account_id: 8, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T03:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: '0',
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: 7, account_cost_rule_id: null, fixed_period_id: null,
              rate_observation_id: 41, observed_upstream_multiplier: '0.8',
            },
            {
              source_usage_id: 4, source_account_id: 9, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T04:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: null,
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: 7, account_cost_rule_id: null, fixed_period_id: null,
              rate_observation_id: null, observed_upstream_multiplier: null,
            },
            {
              source_usage_id: 5, source_account_id: 10, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T05:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: null,
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: null, account_cost_rule_id: null, fixed_period_id: null,
              rate_observation_id: 52, observation_status: 'ok', observation_source_kind: 'supplier_direct_probe',
              observation_fresh_until: new Date('2026-07-31T05:30:00Z'), observed_resolved_multiplier: '0.7',
              observed_upstream_multiplier: '0.7', observed_peak_enabled: false,
            },
            {
              source_usage_id: 6, source_account_id: 11, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T06:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: null,
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: null, account_cost_rule_id: 61, fixed_period_id: null,
              configured_supplier_key_id: 77, supplier_inventory_multiplier: '0.05',
              supplier_rate_observation_id: 88, supplier_observed_multiplier: '0.06',
              rate_observation_id: 53, observation_status: 'ok', observation_source_kind: 'supplier_direct_probe',
              observation_fresh_until: new Date('2026-07-31T06:30:00Z'), observed_resolved_multiplier: '0.9',
              observed_upstream_multiplier: '0.9', observed_peak_enabled: false,
            },
            {
              source_usage_id: 7, source_account_id: 12, source_user_id: 3, source_group_id: 2,
              model: 'gpt-test', occurred_at: new Date('2026-07-31T07:00:00Z'),
              user_charge_cny: '100', standard_cost_usd_reference: '10',
              source_selling_multiplier: '2', source_account_multiplier: null,
              configured_cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve',
              selling_multiplier: '2', manual_upstream_multiplier: null, cny_per_reference_unit: null,
              cost_profile_id: null, account_cost_rule_id: 62, fixed_period_id: null,
              configured_supplier_key_id: 78, supplier_inventory_multiplier: '0.04',
              supplier_rate_observation_id: null, supplier_observed_multiplier: null,
              rate_observation_id: null, observed_upstream_multiplier: null,
            },
          ],
          rowCount: 7,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public',
  });
  const total = await service.freezePendingUsageCostSnapshots(client, 'historical_backfill');
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".fact_usage_cost_snapshots'));
  assert.equal(total, 7);
  assert.match(insert.text, /ON CONFLICT\(source_usage_id\) DO NOTHING/);
  assert.equal(insert.params.length, 7 * COST_SNAPSHOT_COLUMN_COUNT);
  const row = (index) => insert.params.slice(index * COST_SNAPSHOT_COLUMN_COUNT, (index + 1) * COST_SNAPSHOT_COLUMN_COUNT);
  assert.equal(row(0)[17], '0.8');
  assert.equal(row(0)[19], 'probe_observation');
  assert.equal(row(0)[20], 'priced');
  assert.equal(row(0)[21], '40');
  assert.equal(row(1)[17], '0.8');
  assert.equal(row(1)[19], 'probe_observation');
  assert.equal(row(2)[10], 'free');
  assert.equal(row(2)[20], 'free');
  assert.equal(row(2)[21], '0');
  assert.equal(row(3)[20], 'missing_upstream_multiplier');
  assert.equal(row(3)[21], null);
  assert.equal(row(4)[10], 'probe_multiplier');
  assert.equal(row(4)[17], '0.7');
  assert.equal(row(4)[19], 'supplier_direct_probe');
  assert.equal(row(4)[20], 'priced');
  assert.equal(row(4)[21], '35');
  assert.equal(row(5)[17], '0.06');
  assert.equal(row(5)[19], 'supplier_key_history');
  assert.equal(row(5)[20], 'priced');
  assert.equal(row(5)[21], '3');
  assert.equal(row(6)[17], null);
  assert.equal(row(6)[19], '');
  assert.equal(row(6)[20], 'missing_upstream_multiplier');
  assert.equal(row(6)[21], null);
  const selection = queries.find((query) => query.text.includes('FROM "finops".fact_usage_events f'));
  assert.match(selection.text, /WITH pending_usage AS MATERIALIZED/);
  assert.match(selection.text, /LEFT JOIN "finops"\.fact_usage_cost_snapshots current_snapshot/);
  assert.doesNotMatch(selection.text, /WHERE NOT EXISTS/);
  assert.match(selection.text, /SELECT o\.id,o\.status,o\.source_kind,o\.resolved_rate_multiplier,o\.effective_rate_multiplier/);
  assert.match(selection.text, /supplier_key_observations key_rate/);
  assert.doesNotMatch(selection.text, /key_rate\.rate_multiplier IS NOT NULL/);
  assert.doesNotMatch(selection.text, /supplier_account_links supplier_link/);
  assert.match(selection.text, /rule\.supplier_key_id AS configured_supplier_key_id/);
  assert.match(selection.text, /r\.supplier_key_id IS NULL OR r\.created_at <= f\.occurred_at/);
  assert.match(selection.text, /key_rate\.observed_at<=f\.occurred_at/);
  assert.doesNotMatch(selection.text, /AND o\.status='ok'/);
  assert.doesNotMatch(selection.text, /COALESCE\(o\.observed_at,o\.received_at,o\.last_attempt_at,o\.captured_at\)/);
  assert.match(selection.text, /GREATEST\(\s+COALESCE\(o\.observed_at,'-infinity'::timestamptz\),\s+COALESCE\(o\.received_at,'-infinity'::timestamptz\),\s+COALESCE\(o\.last_attempt_at,'-infinity'::timestamptz\),\s+COALESCE\(o\.captured_at,'-infinity'::timestamptz\)\s+\)/);
  assert.match(selection.text, /WHEN observation\.status='ok'\s+AND observation\.effective_rate_multiplier>=0\s+AND observation\.fresh_until>f\.occurred_at THEN 'probe_multiplier'/);
});

test('open usage cost snapshots refresh while finalized history remains immutable', async () => {
  const queries = [];
  let selected = false;
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO "finops".fact_usage_cost_snapshots')) {
        return { rows: [], rowCount: params.length / COST_SNAPSHOT_COLUMN_COUNT };
      }
      if (text.includes('FROM "finops".fact_usage_events f')) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return {
          rows: [{
            source_usage_id: 10, source_account_id: 8, source_user_id: 3, source_group_id: 2,
            model: 'gpt-test', occurred_at: new Date('2026-08-01T01:00:00Z'),
            user_charge_cny: '100', standard_cost_usd_reference: '10',
            source_selling_multiplier: '2', source_account_multiplier: null,
            configured_cost_mode: 'manual_multiplier', basis_mode: 'revenue_backsolve',
            selling_multiplier: '2', manual_upstream_multiplier: '0.08', cny_per_reference_unit: null,
            cost_profile_id: 7, account_cost_rule_id: 51, selling_rate_rule_id: null,
            fixed_period_id: null, rate_observation_id: null, observed_upstream_multiplier: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: text.includes('UPDATE "finops".fact_usage_cost_snapshots') ? 2 : 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'Asia/Shanghai',
  });
  assert.equal(await service.freezePendingUsageCostSnapshots(client, 'live_sync', { refreshOpenDay: true }), 1);
  assert.equal(await service.finalizeUsageCostSnapshots(client), 2);
  const refresh = queries.find((query) => query.text.includes('INSERT INTO "finops".fact_usage_cost_snapshots'));
  const finalize = queries.find((query) => query.text.includes('SET finalized=TRUE'));
  const select = queries.find((query) => query.text.includes('FROM "finops".fact_usage_events f'));
  assert.match(select.text, /NULLIF\(f\.user_rate_multiplier,0\) AS selling_multiplier/);
  assert.doesNotMatch(select.text, /group_selling_rate_rules|default_selling_multiplier|rule\.selling_multiplier/);
  assert.match(select.text, /snapshot\.finalized=FALSE/);
  assert.doesNotMatch(select.text, /current_snapshot\.cost_status NOT IN \('priced','free','fixed_cost'\)/);
  assert.match(refresh.text, /ON CONFLICT\(source_usage_id\) DO UPDATE SET/);
  assert.match(refresh.text, /WHERE NOT fact_usage_cost_snapshots\.finalized/);
  assert.match(refresh.text, /finalized=FALSE/);
  assert.doesNotMatch(refresh.text, /fact_usage_cost_snapshots\.cost_status NOT IN \('priced','free','fixed_cost'\)/);
  assert.equal(refresh.params.length, COST_SNAPSHOT_COLUMN_COUNT);
  assert.equal(refresh.params[14], null);
  assert.equal(refresh.params[16], '2');
  assert.equal(refresh.params[23], 4);
  assert.match(finalize.text, /finalized=TRUE/);
  assert.match(finalize.text, /date_trunc\('day', NOW\(\) AT TIME ZONE \$1\)/);
});

test('supplier cost refresh defers to an active main synchronization cycle', async () => {
  const service = new SyncService(null, {
    connect: async () => assert.fail('cost refresh should not open a competing transaction'),
  }, { finopsSchema: 'finops', sourceSchema: 'public' });
  service.running = true;
  assert.equal(await service.refreshQueuedUsageCosts(), 0);
});

test('fixed daily snapshots use local midnight boundaries and finalization leaves closed days immutable', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      return { rows: [], rowCount: text.includes('account_cost_daily_snapshots') ? 2 : 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'Asia/Shanghai',
  });
  assert.equal(await service.captureFixedCostDailySnapshots(client, 'live_sync'), 2);
  assert.equal(await service.finalizeCostDailySnapshots(client), 2);
  const capture = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_daily_snapshots'));
  assert.match(capture.text, /date_trunc\('day',p\.effective_from AT TIME ZONE \$1\)/);
  assert.match(capture.text, /EXTRACT\(EPOCH FROM \(overlap_ended_at-overlap_started_at\)\)/);
  assert.match(capture.text, /WHERE NOT account_cost_daily_snapshots\.finalized/);
  assert.match(queries.at(-1).text, /day < \(\$1::date - \(\$2::int \* INTERVAL '1 day'\)\)/);
});

test('payment refund cash transaction binds source update and metadata separately', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO "finops".credit_events')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (text.includes('SELECT DISTINCT source_user_id')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, { finopsSchema: 'finops', sourceSchema: 'public' });
  await service.upsertPaymentRow(client, {
    id: 7,
    user_id: 3,
    pay_amount: '88.00',
    amount: '100.00',
    currency: 'CNY',
    provider_snapshot: {},
    payment_type: 'mock',
    order_type: 'balance',
    status: 'REFUNDED',
    refund_amount: '25.00',
    paid_at: new Date('2026-07-01T00:00:00Z'),
    refund_at: new Date('2026-07-02T00:00:00Z'),
    updated_at: new Date('2026-07-02T00:00:00Z'),
  });
  const refund = queries.find((query) => query.text.includes("'refund','out'"));
  assert.ok(refund);
  assert.match(refund.text, /TRUE,\$14,\$15::jsonb/);
  assert.equal(refund.params.length, 15);
});

test('usage timestamp corrections refresh both the old and new daily partitions', async () => {
  const rebuilt = [];
  let refreshedDays = [];
  const client = {
    async query(text) {
      if (text.includes('SELECT source_usage_id,source_user_id,user_charge_cny')) {
        return {
          rows: [{
            source_usage_id: 11,
            source_user_id: 5,
            user_charge_cny: '2.5',
            billing_type: 0,
            occurred_at: new Date('2026-07-01T01:00:00Z'),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC', sourceBalanceUnit: 'CNY',
  });
  service.rebuildUserLedger = async (_client, userId) => rebuilt.push(userId);
  service.allocatePendingUsage = async () => assert.fail('timestamp changes must rebuild the ledger');
  service.refreshUsageDaily = async (_client, days) => { refreshedDays = days; };
  await service.upsertUsageRows(client, [{
    source_usage_id: 11,
    source_user_id: 5,
    billing_type: 0,
    user_charge_cny: '2.5',
    standard_cost_usd_reference: '3',
    occurred_at: new Date('2026-07-02T01:00:00Z'),
  }]);
  assert.deepEqual(rebuilt, [5]);
  assert.deepEqual(refreshedDays.sort(), ['2026-07-01', '2026-07-02']);
});

test('daily usage rollups fall back from an empty primary model to requested and upstream models', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'Asia/Shanghai', sourceBalanceUnit: 'CNY',
  });

  await service.refreshUsageDaily(client, ['2026-08-03']);

  const aggregate = queries.find((query) => query.text.includes('INSERT INTO "finops".fact_usage_daily'));
  assert.ok(aggregate);
  assert.deepEqual(aggregate.params, [['2026-08-03'], 'Asia/Shanghai']);
  assert.match(aggregate.text, /NULLIF\(BTRIM\(model\),''\),NULLIF\(BTRIM\(requested_model\),''\)/);
  assert.match(aggregate.text, /NULLIF\(BTRIM\(upstream_model\),''\)/);
  assert.doesNotMatch(aggregate.text, /sub2api\./);
});

test('usage mapping keeps the source charge in CNY without an upstream CNY cost field', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT source_usage_id,source_user_id,user_charge_cny')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC', sourceBalanceUnit: 'CNY',
  });
  service.allocatePendingUsage = async () => {};
  service.refreshUsageDaily = async () => {};
  await service.upsertUsageRows(client, [{
    source_usage_id: 12, source_user_id: 5, billing_type: 0,
    standard_cost_usd_reference: '4.75', user_charge_cny: '2.5',
    occurred_at: new Date('2026-07-02T01:00:00Z'),
  }]);
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".fact_usage_events'));
  assert.ok(insert);
  assert.equal(insert.params.length, USAGE_COLUMN_COUNT);
  assert.equal(insert.params[22], '4.75');
  assert.equal(insert.params[23], '2.5');
  assert.doesNotMatch(insert.text, /usd_credit|upstream_cost_cny_estimate|estimated_upstream_cost_cny|credit_currency/);
});

test('usage source query never treats account statistics pricing as a CNY cost', async () => {
  const sourceQueries = [];
  const targetQueries = [];
  const sourcePool = {
    async query(text, params = []) {
      sourceQueries.push({ text, params });
      if (text.includes('FROM "public".usage_logs')) return { rows: [], rowCount: 0 };
      assert.fail(`unexpected source query: ${text}`);
    },
  };
  const client = {
    async query(text, params = []) {
      targetQueries.push({ text, params });
      if (text.includes('SELECT cursor_time,cursor_id')) {
        return { rows: [{ cursor_time: '1970-01-01 00:00:00+00', cursor_id: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const targetPool = {
    async query(text, params = []) {
      targetQueries.push({ text, params });
      if (text.includes('SELECT cursor_time,cursor_id')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client,
  };
  const service = new SyncService(sourcePool, targetPool, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC', sourceBalanceUnit: 'CNY', syncBatchSize: 1000,
  });
  await service.syncUsage();
  const sourceQuery = sourceQueries.find((query) => query.text.includes('FROM "public".usage_logs'));
  assert.ok(sourceQuery);
  assert.match(sourceQuery.text, /total_cost AS standard_cost_usd_reference/);
  assert.match(sourceQuery.text, /actual_cost AS user_charge_cny/);
  assert.match(sourceQuery.text, /0::smallint AS billing_type/);
  assert.doesNotMatch(sourceQuery.text, /COALESCE\(billing_type/);
  assert.doesNotMatch(sourceQuery.text, /account_stats_cost|estimated_upstream_cost/);
  assert.ok(!targetQueries.some((query) => query.text.includes('"public".usage_logs')));
});

test('affiliate sync preserves microsecond cursors and skips unchanged ledger rebuilds', async () => {
  const cursorTime = '2026-08-09 02:36:44.469738+00';
  const nextCursorTime = '2026-08-10 01:16:09.899839+00';
  const sourceQueries = [];
  const targetQueries = [];
  const rebuilt = [];
  const sourcePool = {
    async query(text, params = []) {
      sourceQueries.push({ text, params });
      return {
        rows: [{
          id: 10000114,
          user_id: 57,
          action: 'accrue',
          amount: '0.5',
          source_user_id: 69,
          source_order_id: 10000201,
          created_at: new Date('2026-08-07T13:45:30.879Z'),
          updated_at: new Date('2026-08-10T01:16:09.899Z'),
          cursor_time_key: nextCursorTime,
        }],
        rowCount: 1,
      };
    },
  };
  const client = {
    async query(text, params = []) {
      targetQueries.push({ text, params });
      if (text.includes('SELECT cursor_time::text') && text.includes('FOR UPDATE')) {
        return { rows: [{ cursor_time: cursorTime, cursor_id: 10000116 }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "finops".credit_events')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const targetPool = {
    async query(text, params = []) {
      targetQueries.push({ text, params });
      if (text.includes('SELECT cursor_time::text')) {
        return { rows: [{ cursor_time: cursorTime, cursor_id: 10000116 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client,
  };
  const service = new SyncService(sourcePool, targetPool, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC', syncBatchSize: 1000,
  });
  service.rebuildUserLedger = async (_client, userId) => rebuilt.push(userId);

  assert.equal(await service.syncAffiliateLedger(), 1);
  assert.equal(sourceQueries[0].params[0], cursorTime);
  assert.match(sourceQueries[0].text, /updated_at::text AS cursor_time_key/);
  assert.deepEqual(rebuilt, []);
  const markSuccess = targetQueries.find((query) => query.text.includes('SET cursor_time=$1'));
  assert.deepEqual(markSuccess.params, [nextCursorTime, 10000114, 1, 'user_affiliate_ledger']);
});

test('FIFO rebuild applies a later credit lot to an earlier usage deficit', async () => {
  const recognition = [];
  const lotUpdates = [];
  const client = {
    async query(text, params = []) {
      if (text.includes('SELECT * FROM (')) {
        return {
          rows: [
            {
              kind: 'usage', kind_order: 1, event_id: 91,
              occurred_at: new Date('2026-07-01T00:00:00Z'), direction: 'out',
              credit_amount: '5', cash_basis_cny: '0', metadata: {},
            },
            {
              kind: 'credit', kind_order: 0, event_id: 7,
              occurred_at: new Date('2026-07-02T00:00:00Z'), direction: 'in',
              credit_amount: '10', cash_basis_cny: '10', metadata: { order_type: 'balance' },
            },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('INSERT INTO "finops".credit_lots')) {
        return {
          rows: [{
            id: 70, source_event_id: 7, granted_credit: '10', remaining_credit: '10', cash_basis_cny: '10',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO "finops".revenue_recognition')) recognition.push(params);
      if (text.includes('UPDATE "finops".credit_lots AS lot')) lotUpdates.push(params);
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC',
  });
  service.refreshUsageDaily = async () => {};
  await service.rebuildUserLedger(client, 5);
  assert.deepEqual(recognition, [[91, 70, '5', '5']]);
  assert.deepEqual(lotUpdates.at(-1), [70, '5']);
});

test('wallet reconciliation establishes a baseline then records matching deltas', async () => {
  let phase = 0;
  const inserts = [];
  const client = {
    async query(text, params = []) {
      if (text.includes('WITH ledger_activity AS')) {
        return { rows: [{ source_user_id: 5, source_balance_cny: phase ? '12' : '10', ledger_activity_cny: phase ? '2' : '0' }], rowCount: 1 };
      }
      if (text.includes('wallet_reconciliation_snapshots') && text.includes('FOR UPDATE')) {
        return phase ? { rows: [{ source_user_id: 5, source_balance_cny: '10', ledger_activity_cny: '0' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO "finops".reconciliation_runs')) inserts.push(params);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const service = new SyncService({ connect: async () => client }, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC',
  });
  assert.deepEqual(await service.reconcileWalletBalances(), { status: 'baseline', userCount: 1, mismatchCount: 0 });
  phase = 1;
  assert.deepEqual(await service.reconcileWalletBalances(), { status: 'matched', userCount: 1, mismatchCount: 0 });
  assert.equal(inserts[0][0], 'baseline');
  assert.equal(inserts[1][0], 'matched');
  assert.equal(inserts[1][1], '2');
  assert.equal(inserts[1][2], '2');
});
