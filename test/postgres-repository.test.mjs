import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveCostCny,
  PostgresRepository,
  REQUIRED_SYNC_SOURCES,
  SYNC_SOURCE_LABELS,
} from '../src/repositories/postgres-repository.mjs';

const config = { finopsSchema: 'finops', timezone: 'Asia/Shanghai' };

test('effective account cost uses only explicitly registered CNY cost periods', () => {
  assert.equal(effectiveCostCny('metered', 12, 8), 8);
  assert.equal(effectiveCostCny('subscription', 12, 8), 8);
  assert.equal(effectiveCostCny('prepaid', 12, 8), 8);
  assert.equal(effectiveCostCny('one_time', 12, 8), 8);
  assert.equal(effectiveCostCny('free', 12, 8), 0);
  assert.equal(effectiveCostCny('hybrid', 12, 8), 8);
  assert.equal(effectiveCostCny('unconfigured', 12, 8), 8);
  assert.equal(effectiveCostCny(undefined, 12, 8), 8);
  assert.equal(effectiveCostCny('metered', 12, 0), 0);
  assert.equal(effectiveCostCny('subscription', 12, 0), 0);
});

test('sync state is pending when a required cursor is absent', async () => {
  const completeRows = REQUIRED_SYNC_SOURCES
    .filter((sourceName) => sourceName !== 'credit_reconciliation')
    .map((source_name) => ({
      source_name,
      cursor_time: '2026-07-26T00:00:00.000Z',
      last_success_at: '2026-07-26T00:00:00.000Z',
      last_error: null,
      rows_synced: 10,
    }));
  const pool = { query: async () => ({ rows: completeRows, rowCount: completeRows.length }) };
  const repository = new PostgresRepository(pool, config);

  const state = await repository.getSyncState();

  assert.equal(state.status, 'pending');
  assert.deepEqual(state.missingSources, ['credit_reconciliation']);
  assert.equal(state.rowsSynced, (REQUIRED_SYNC_SOURCES.length - 1) * 10);
});

test('sync details expose every required source with its Chinese label', async () => {
  const cursorRows = [{
    source_name: 'usage_logs',
    cursor_time: '2026-07-26T00:00:00.000Z',
    last_success_at: '2026-07-26T00:00:00.000Z',
    last_error: null,
    rows_synced: 12,
  }];
  const pool = {
    query: async (sql) => {
      if (sql.includes('sync_cursors')) return { rows: cursorRows, rowCount: cursorRows.length };
      if (sql.includes('dim_users')) return { rows: [{ last_success_at: '2026-07-26T00:00:00.000Z', rows_synced: 2 }], rowCount: 1 };
      return { rows: [{ last_success_at: '2026-07-26T00:00:00.000Z', rows_synced: 1 }], rowCount: 1 };
    },
  };
  const repository = new PostgresRepository(pool, config);

  const details = await repository.getSyncDetails();

  assert.equal(details.status, 'pending');
  for (const sourceName of REQUIRED_SYNC_SOURCES) {
    const source = details.sources.find((item) => item.sourceName === sourceName);
    assert.ok(source);
    assert.equal(source.label, SYNC_SOURCE_LABELS[sourceName]);
  }
  assert.equal(details.sources.find((item) => item.sourceName === 'usage_logs').label, '用量与扣费');
  assert.equal(details.sources.find((item) => item.sourceName === 'payment_orders').label, '充值与退款');
  assert.equal(details.sources.find((item) => item.sourceName === 'credit_reconciliation').label, '额度对账');
});
