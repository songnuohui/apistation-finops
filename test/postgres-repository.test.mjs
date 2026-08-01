import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatedCostSql,
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

test('cost allocation respects standard, token, and no-allocation rules', () => {
  const standard = allocatedCostSql('method', 'cost', 'standard', 'total_standard', 'tokens', 'total_tokens', 'requests', 'total_requests');
  assert.match(standard, /WHEN 'none' THEN 0/);
  assert.match(standard, /WHEN 'token_weight'/);
  assert.match(standard, /cost\*standard\/total_standard/);
  assert.match(standard, /cost\*tokens\/total_tokens/);
});

test('fixed allocation strategies are rendered as SQL string literals', () => {
  const standard = allocatedCostSql("'standard_cost_weight'", 'cost', 'standard', 'total_standard', 'tokens', 'total_tokens', 'requests', 'total_requests');
  const token = allocatedCostSql("'token_weight'", 'cost', 'standard', 'total_standard', 'tokens', 'total_tokens', 'requests', 'total_requests');
  assert.match(standard, /COALESCE\('standard_cost_weight', 'standard_cost_weight'\)/);
  assert.match(token, /COALESCE\('token_weight', 'standard_cost_weight'\)/);
});

test('daily usage rollups bind timezone-safe date keys separately from exact cost windows', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const start = new Date('2026-07-01T16:00:00.000Z');
  const end = new Date('2026-07-30T04:00:00.000Z');
  const range = {
    start, end, dailyStart: '2026-07-02', dailyEnd: '2026-07-30',
    search: 'OpenAI', page: 1, pageSize: 20, offset: 0,
  };

  await repository.getTrend(range);
  await repository.getUsageBreakdown(range);
  await repository.listUsers(range);
  await repository.listAccounts(range);
  await repository.getSupplierOverview(range);

  assert.deepEqual(queries.find((query) => query.text.includes('WITH days AS')).params, [
    '2026-07-02', '2026-07-30', 'Asia/Shanghai', start, end,
  ]);
  assert.deepEqual(queries.find((query) => query.text.includes('usage_by_model_account')).params, [
    '2026-07-02', '2026-07-30', start, end, 20, 0,
  ]);
  assert.deepEqual(queries.find((query) => query.text.includes('usage_by_user_account')).params, [
    '2026-07-02', '2026-07-30', start, end, 'OpenAI', 20, 0,
  ]);
  assert.deepEqual(queries.find((query) => query.text.includes('WITH usage AS') && query.text.includes('LIMIT $6 OFFSET $7')).params, [
    '2026-07-02', '2026-07-30', start, end, 'OpenAI', 20, 0,
  ]);
  assert.deepEqual(queries.find((query) => query.text.includes('FROM account_economics GROUP BY supplier')).params, [
    '2026-07-02', '2026-07-30', start, end, 'OpenAI',
  ]);
  const usageByModel = queries.find((query) => query.text.includes('usage_by_model_account')).text;
  const usageByUser = queries.find((query) => query.text.includes('usage_by_user_account')).text;
  const accounts = queries.find((query) => query.text.includes('WITH usage AS') && query.text.includes('LIMIT $6 OFFSET $7')).text;
  const suppliers = queries.find((query) => query.text.includes('FROM account_economics GROUP BY supplier')).text;
  assert.match(usageByModel, /COALESCE\('standard_cost_weight', 'standard_cost_weight'\)/);
  assert.match(usageByUser, /COALESCE\('token_weight', 'standard_cost_weight'\)/);
  assert.match(accounts, /LEAST\(p\.effective_to,\$4\)/);
  assert.match(accounts, /a\.source_deleted_at IS NULL AND a\.status='active'/);
  assert.match(suppliers, /WHERE p\.status='active' AND p\.effective_from < \$4 AND p\.effective_to > \$3/);
  assert.deepEqual(queries.find((query) => query.text.includes('SELECT p.id,p.source_account_id')).params, [
    start, end, 'OpenAI',
  ]);
});

test('account cost periods inherit the selected account profile when no explicit profile is supplied', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT a.source_account_id,a.cost_profile_id')) {
        return { rows: [{ source_account_id: 8, cost_profile_id: 42, cost_type: 'metered' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "finops".account_cost_periods')) return { rows: [{ id: 9 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  await repository.createAccountCostPeriod({
    accountId: 8, costProfileId: null, supplier: '', purchaseBatch: '',
    originalAmount: '10', originalCurrency: 'CNY', fxRate: '1', baseAmount: '10',
    feeAmount: '0', taxAmount: '0', effectiveFrom: '2026-07-01T00:00:00Z',
    effectiveTo: '2026-08-01T00:00:00Z', notes: '', tags: null,
  });
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_periods'));
  assert.equal(insert.params[1], 42);
});

test('account cost history uses a bounded page query scoped to one account', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      return {
        rows: [{
          id: 9, source_account_id: 8, cost_profile_id: null, cost_profile: '未绑定模板',
          supplier: 'Supplier A', purchase_batch: 'B-001', original_amount: '10',
          fee_amount: '1', tax_amount: '0', total_cost_cny: '11', original_currency: 'CNY',
          effective_from: '2026-07-01T00:00:00Z', effective_to: '2026-08-01T00:00:00Z',
          status: 'active', notes: '', total_count: '3',
        }],
        rowCount: 1,
      };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const result = await repository.listAccountCostPeriods({ accountId: 8, page: 2, pageSize: 20, offset: 20 });
  assert.equal(result.total, 3);
  assert.equal(result.items[0].totalCost, 11);
  assert.deepEqual(queries[0].params, [8, 20, 20]);
  assert.match(queries[0].text, /WHERE p\.source_account_id=\$1/);
});

test('monitor candidates merge the sanitized source catalog with usage activity', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      return {
        rows: [{
          source_group_id: 21,
          name: 'Codex 主力',
          platform: 'openai',
          status: 'active',
          rate_multiplier: '0.08',
          sort_order: 2,
          default_model: 'gpt-5.6',
          catalog_synced_at: '2026-08-01T06:00:00.000Z',
          requests: 123,
          last_used_at: '2026-08-01T06:30:00.000Z',
          latest_model: 'gpt-5.6',
        }],
        rowCount: 1,
      };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const candidates = await repository.listMonitorGroupCandidates();
  assert.deepEqual(candidates[0], {
    sourceGroupId: 21,
    name: 'Codex 主力',
    platform: 'openai',
    status: 'active',
    groupMultiplier: 0.08,
    sortOrder: 2,
    defaultModel: 'gpt-5.6',
    catalogSyncedAt: '2026-08-01T06:00:00.000Z',
    requests: 123,
    lastUsedAt: '2026-08-01T06:30:00.000Z',
    latestModel: 'gpt-5.6',
  });
  assert.match(queries[0].text, /source_group_catalog/);
  assert.doesNotMatch(queries[0].text, /credentials|model_routing/i);
});

test('first account multiplier of the day starts at local midnight', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:00:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: false,
            first_today_multiplier_rule_id: null,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO "finops".account_cost_rules')) {
        return { rows: [{ effective_from: params[7] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const rule = await repository.upsertAccountCostRule(client, 8, {
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.05', sellingMultiplier: '2', cnyPerReferenceUnit: null, notes: '',
  });
  assert.equal(rule.effective_from, '2026-07-31T16:00:00.000Z');
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_rules'));
  assert.equal(insert.params[7], '2026-07-31T16:00:00.000Z');
  assert.match(queries[0].text, /date_trunc\('day', NOW\(\) AT TIME ZONE \$2\)/);
});

test('same-day account multiplier changes preserve the first rule at midnight and split later changes by time', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:00:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: false,
            first_today_multiplier_rule_id: 41,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO "finops".account_cost_rules')) {
        return { rows: [{ effective_from: params[7] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const rule = await repository.upsertAccountCostRule(client, 8, {
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.08', sellingMultiplier: '2', cnyPerReferenceUnit: null, notes: '',
  });
  const anchored = queries.find((query) => (
    query.text.includes('UPDATE "finops".account_cost_rules')
    && query.text.includes('SET effective_from=$2')
  ));
  const superseded = queries.find((query) => (
    query.text.includes('SET effective_to=$2,status')
  ));
  assert.deepEqual(anchored.params, [41, '2026-07-31T16:00:00.000Z', '2026-08-01T04:00:00.000Z']);
  assert.deepEqual(superseded.params, [8, '2026-08-01T04:00:00.000Z']);
  assert.equal(rule.effective_from, '2026-08-01T04:00:00.000Z');
});

test('group selling multiplier history starts at midnight then uses the observed source update time', async () => {
  const firstQueries = [];
  const firstClient = {
    async query(text, params = []) {
      firstQueries.push({ text, params });
      if (text.includes('FROM "finops".group_selling_rate_rules') && text.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('WITH clock AS')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:10:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: false,
            first_today_rule_id: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const firstRepository = new PostgresRepository({ connect: async () => firstClient }, config);
  await firstRepository.upsertSourceGroupCatalog([{
    sourceGroupId: 21, name: 'OpenAI', platform: 'openai', status: 'active',
    groupMultiplier: '0.05', sortOrder: 0, defaultModel: 'gpt-test', sourceUpdatedAt: null,
  }]);
  const firstRule = firstQueries.find((query) => query.text.includes('INSERT INTO "finops".group_selling_rate_rules'));
  assert.equal(firstRule.params[2], '2026-07-31T16:00:00.000Z');

  const changedQueries = [];
  const changedClient = {
    async query(text, params = []) {
      changedQueries.push({ text, params });
      if (text.includes('FROM "finops".group_selling_rate_rules') && text.includes('FOR UPDATE')) {
        return {
          rows: [{ id: 71, selling_multiplier: '0.05', effective_from: '2026-07-31T16:00:00.000Z' }],
          rowCount: 1,
        };
      }
      if (text.includes('WITH clock AS')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:10:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: true,
            first_today_rule_id: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const changedRepository = new PostgresRepository({ connect: async () => changedClient }, config);
  await changedRepository.upsertSourceGroupCatalog([{
    sourceGroupId: 21, name: 'OpenAI', platform: 'openai', status: 'active',
    groupMultiplier: '0.08', sortOrder: 0, defaultModel: 'gpt-test',
    sourceUpdatedAt: '2026-08-01T04:00:00.000Z',
  }]);
  const close = changedQueries.find((query) => query.text.includes('SET effective_to=$2,status'));
  const nextRule = changedQueries.find((query) => query.text.includes('INSERT INTO "finops".group_selling_rate_rules'));
  assert.deepEqual(close.params, [71, '2026-08-01T04:00:00.000Z']);
  assert.equal(nextRule.params[2], '2026-08-01T04:00:00.000Z');
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
