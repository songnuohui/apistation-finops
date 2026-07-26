import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSourceUnitContract, MAX_USAGE_ROWS_PER_INSERT, REQUIRED_SOURCE_COLUMNS,
  refundCashAmount, SyncService, USAGE_COLUMN_COUNT,
} from '../src/services/sync-service.mjs';
import { loadConfig } from '../src/config.mjs';

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
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT cursor_time,cursor_id')) {
        return { rows: [{ cursor_time: '1970-01-01 00:00:00+00', cursor_id: 0 }], rowCount: 1 };
      }
      if (text.includes('FROM "public".usage_logs')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const service = new SyncService({ connect: async () => client }, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC', sourceBalanceUnit: 'CNY', syncBatchSize: 1000,
  });
  await service.syncUsage();
  const sourceQuery = queries.find((query) => query.text.includes('FROM "public".usage_logs'));
  assert.ok(sourceQuery);
  assert.match(sourceQuery.text, /total_cost AS standard_cost_usd_reference/);
  assert.match(sourceQuery.text, /actual_cost AS user_charge_cny/);
  assert.doesNotMatch(sourceQuery.text, /account_stats_cost|estimated_upstream_cost/);
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
        return { rows: [{ id: 70, granted_credit: '10', remaining_credit: '10', cash_basis_cny: '10' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "finops".revenue_recognition')) recognition.push(params);
      if (text.includes('UPDATE "finops".credit_lots SET remaining_credit')) lotUpdates.push(params);
      return { rows: [], rowCount: 0 };
    },
  };
  const service = new SyncService(null, {
    finopsSchema: 'finops', sourceSchema: 'public', timezone: 'UTC',
  });
  service.refreshUsageDaily = async () => {};
  await service.rebuildUserLedger(client, 5);
  assert.deepEqual(recognition, [[91, 70, '5', '5']]);
  assert.deepEqual(lotUpdates.at(-1), ['5', 70]);
});
