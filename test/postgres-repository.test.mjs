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

test('account ledger treats an active linked supplier-key multiplier as automatic cost input', async () => {
  let statement = '';
  const repository = new PostgresRepository({
    async query(text) {
      statement = text;
      return { rows: [], rowCount: 0 };
    },
  }, config);

  await repository.listAccounts({
    start: new Date('2026-08-01T00:00:00Z'),
    end: new Date('2026-08-02T00:00:00Z'),
    dailyStart: '2026-08-01', dailyEnd: '2026-08-01', page: 1, pageSize: 20, offset: 0,
  });

  assert.match(statement, /linked_key\.status='active' AND linked_key\.rate_multiplier IS NOT NULL/);
  assert.match(statement, /THEN 'supplier_key_inventory'/);
  assert.match(statement, /THEN linked_key\.rate_multiplier END/);
});

test('supplier connection profit guard coverage includes linked account policies', async () => {
  let statement = '';
  const repository = new PostgresRepository({
    async query(text) {
      statement = text;
      return { rows: [{
        id: '9', supplier_id: '4', supplier_name: 'Provider A', name: 'main',
        adapter_type: 'sub2api', base_url: 'https://provider.example', auth_mode: 'password',
        credentials_ciphertext: 'encrypted', enabled: true, inventory_interval_seconds: 30,
        balance_currency: 'USD', connection_status: 'ok', linked_account_count: '1',
        profit_guard_configured_account_count: '1', profit_guard_account_count: '1',
        profit_guard_configured: true, profit_guard_enabled: true, profit_guard_fully_enabled: true,
      }], rowCount: 1 };
    },
  }, config);

  const connection = (await repository.listSupplierConnections()).items[0];
  assert.match(statement, /account_profit_guard_policies policies/);
  assert.match(statement, /enabled_account_count=guard_accounts\.linked_account_count/);
  assert.equal(connection.linkedAccountCount, 1);
  assert.equal(connection.profitGuardConfiguredAccountCount, 1);
  assert.equal(connection.profitGuardAccountCount, 1);
  assert.equal(connection.profitGuardFullyEnabled, true);
});

test('supplier connection details reuse one checked-out client and defer account candidates', async () => {
  const clientQueries = [];
  let released = 0;
  const client = {
    async query(text) {
      clientQueries.push(text);
      if (text.includes('FROM "finops".supplier_keys WHERE connection_id')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "finops".supplier_account_links')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "finops".supplier_balance_snapshots')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "finops".supplier_key_checks')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "finops".supplier_alert_events')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected detail query: ${text}`);
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    async query(text) {
      if (!text.includes('SELECT c.*,s.name AS supplier_name')) throw new Error(`unexpected pool query: ${text}`);
      return {
        rows: [{
          id: '9',
          supplier_id: '4',
          supplier_name: 'Provider A',
          name: 'main',
          adapter_type: 'sub2api',
          base_url: 'https://provider.example',
          auth_mode: 'password',
          enabled: true,
          inventory_interval_seconds: 600,
        }],
        rowCount: 1,
      };
    },
    async connect() {
      return client;
    },
  };
  const repository = new PostgresRepository(pool, config);

  const detail = await repository.getSupplierConnectionDetails(9);

  assert.equal(clientQueries.length, 5);
  assert.equal(released, 1);
  assert.equal('accounts' in detail, false);
});

test('supplier key sync pins the status parameter to text in every SQL context', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('SELECT c.*,s.name AS supplier_name')) {
        return {
          rows: [{
            id: '9',
            supplier_name: 'Provider A',
            inventory_interval_seconds: 600,
            low_balance_threshold: null,
            balance_currency: 'USD',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT * FROM "finops".supplier_keys')) return {
        rows: [{
          id: '77', external_key_id: '596', name: 'upstream-key', masked_key: 'sk-...test',
          status: 'active', rate_multiplier: '0.05', group_id: '', group_name: '', removed_at: null,
        }],
        rowCount: 1,
      };
      if (text.includes('INSERT INTO "finops".supplier_keys')) {
        return {
          rows: [{
            id: '77',
            external_key_id: '596',
            name: 'upstream-key',
            status: 'active',
            rate_multiplier: '0.06',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT source_account_id FROM "finops".supplier_account_links')) {
        return { rows: [{ source_account_id: '42' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);

  await repository.recordSupplierSyncSuccess(9, {
    adapterType: 'sub2api',
    identity: '',
    balance: null,
    balanceCurrency: 'USD',
    keys: [{
      externalId: '596',
      name: 'upstream-key',
      maskedKey: 'sk-...test',
      keyFingerprint: 'fingerprint',
      status: 'active',
      groupId: '',
      groupName: '',
      rateMultiplier: '0.06',
      quotaTotal: null,
      quotaUsed: null,
      quotaRemaining: null,
      quotaCurrency: 'USD',
      expiresAt: null,
      lastUsedAt: null,
      sourceData: {},
    }],
  }, [{
    externalId: '596',
    status: 'ok',
    method: 'billing_metadata',
    httpStatus: 200,
    latencyMs: 12,
    billing: {
      observed_at: new Date().toISOString(),
      group_rate_multiplier: 0.8,
      user_rate_multiplier: 0.9,
      resolved_rate_multiplier: 0.85,
      effective_rate_multiplier: 0.85,
      peak_rate_enabled: false,
      peak_rate_multiplier: null,
      applied_peak_multiplier: null,
      timezone: 'Asia/Shanghai',
    },
  }]);

  const keyInsert = queries.find((query) => query.text.includes('INSERT INTO "finops".supplier_keys'));
  const rateObservationInsert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_rate_observations'));
  assert.ok(queries.some((query) => query.text.includes('pg_advisory_xact_lock')));
  assert.match(keyInsert.text, /VALUES\(\$1,\$2,\$3,\$4,\$5,\$6::text,\$7/);
  assert.match(keyInsert.text, /CASE WHEN \$6::text IN/);
  assert.match(rateObservationInsert.text, /\$13::varchar\(80\)/);
  assert.match(rateObservationInsert.text, /previous\.timezone IS NOT DISTINCT FROM \$13::varchar\(80\)/);
  assert.equal(queries.some((query) => query.text.includes("'supplier_key_changed'")), false);
});

test('supplier key listing reads the latest supplier balance snapshot', async () => {
  const queries = [];
  const pool = {
    async query(text) {
      queries.push(text);
      if (text.includes('FROM key_rows')) {
        return {
          rows: [{
            id: '77',
            connection_id: '9',
            supplier_name: 'Provider A',
            connection_name: 'main',
            base_url: 'https://provider.example',
            platform: 'openai',
            name: 'upstream-key',
            masked_key: 'sk-...test',
            status: 'active',
            supplier_balance: '12.50',
            supplier_balance_currency: 'USD',
            usage_amount_cny: '8.25',
            total_count: '1',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Provider A' }], rowCount: 1 };
      if (text.includes('SELECT DISTINCT platform FROM key_platforms')) return { rows: [{ platform: 'openai' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const result = await repository.listSupplierKeys({ page: 1, pageSize: 20 });

  assert.equal(result.items[0].supplierBalance, 12.5);
  assert.equal(result.items[0].supplierBalanceCurrency, 'USD');
  assert.equal(result.items[0].usageAmountCny, 8.25);
  assert.match(queries[0], /supplier_balance_snapshots/);
  assert.doesNotMatch(queries[0], /c\.balance\s+AS\s+supplier_balance/);
  assert.doesNotMatch(queries[0], /fact_usage_events/);

  await repository.listSupplierKeys({ page: 1, pageSize: 20, sortBy: 'usage_amount' });
  const usageSortedQuery = queries.filter((text) => text.includes('FROM key_rows'))[1];
  assert.match(usageSortedQuery, /fact_usage_events/);
});

test('removed supplier keys detach local account links and stop future automatic pricing', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('SELECT c.*,s.name AS supplier_name')) {
        return {
          rows: [{
            id: '9',
            supplier_name: 'Provider A',
            inventory_interval_seconds: 600,
            low_balance_threshold: null,
            balance_currency: 'USD',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT * FROM "finops".supplier_keys')) {
        return {
          rows: [{
            id: '77',
            external_key_id: '596',
            name: 'upstream-key',
            masked_key: 'sk-...test',
            status: 'active',
            removed_at: null,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "finops".supplier_account_links l') && text.includes('FOR UPDATE OF l')) {
        return {
          rows: [{ source_account_id: '42', account_name: 'account-a' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);

  await repository.recordSupplierSyncSuccess(9, {
    adapterType: 'sub2api',
    identity: '',
    balance: null,
    balanceCurrency: 'USD',
    keys: [],
  }, []);

  const statements = queries.map((query) => query.text);
  assert.ok(statements.some((text) => text.includes('UPDATE "finops".account_cost_rules')));
  assert.ok(statements.some((text) => text.includes('UPDATE "finops".account_rate_observations')));
  assert.ok(statements.some((text) => text.includes('DELETE FROM "finops".supplier_account_links')));
  assert.ok(queries.some((query) => (
    query.text.includes('INSERT INTO "finops".supplier_alert_events')
    && query.params.includes('account_supplier_key_removed')
  )));
});

test('fixed allocation strategies are rendered as SQL string literals', () => {
  const standard = allocatedCostSql("'standard_cost_weight'", 'cost', 'standard', 'total_standard', 'tokens', 'total_tokens', 'requests', 'total_requests');
  const token = allocatedCostSql("'token_weight'", 'cost', 'standard', 'total_standard', 'tokens', 'total_tokens', 'requests', 'total_requests');
  assert.match(standard, /COALESCE\('standard_cost_weight', 'standard_cost_weight'\)/);
  assert.match(token, /COALESCE\('token_weight', 'standard_cost_weight'\)/);
});

test('supplier quality overview loads model, key, and usage data for cross-supplier scoring', async () => {
  const observedAt = new Date().toISOString();
  const pool = {
    async query(text) {
      if (text.includes('FROM "finops".supplier_connections c')) {
        return { rows: [{
          id: '7', supplier_id: '3', supplier_name: 'Provider A', name: 'main',
          adapter_type: 'sub2api', detected_adapter_type: 'sub2api', base_url: 'https://provider.example',
          auth_mode: 'password', credentials_ciphertext: 'encrypted', enabled: true,
          inventory_interval_seconds: 600, quality_monitor_mode: 'hybrid',
          balance_currency: 'USD', connection_status: 'ok',
          key_count: 2, active_key_count: 2, failed_key_count: 0, open_alert_count: 0,
          enabled_target_count: 1,
        }, {
          id: '8', supplier_id: '4', supplier_name: 'Provider B', name: 'main',
          adapter_type: 'newapi', detected_adapter_type: 'newapi', base_url: 'https://provider-b.example',
          auth_mode: 'password', credentials_ciphertext: 'encrypted', enabled: true,
          inventory_interval_seconds: 600, quality_monitor_mode: 'hybrid',
          balance_currency: 'USD', connection_status: 'ok',
          key_count: 1, active_key_count: 1, failed_key_count: 0, open_alert_count: 0,
          enabled_target_count: 1,
        }] };
      }
      if (text.includes('FROM "finops".supplier_quality_observations')) {
        assert.match(text, /observed_at>?\s*=\$1 AND observed_at<\$2/);
        return { rows: Array.from({ length: 200 }, (_, index) => ({
          id: String(index + 1),
          connection_id: index < 100 ? '7' : '8',
          supplier_key_id: index < 100 ? '70' : '80',
          source_kind: 'active_probe',
          model: 'gpt-4o-mini',
          group_name: '',
          status: 'ok',
          availability_sample: true,
          http_status: 200,
          ttft_ms: index < 100 ? 800 : 1200,
          duration_ms: 1600,
          ping_latency_ms: null,
          rate_multiplier: index < 100 ? '0.08' : '0.16',
          observed_at: observedAt,
          metadata: {},
        })) };
      }
      if (text.includes('SELECT id,connection_id,name,masked_key')) {
        return { rows: [
          { id: '70', connection_id: '7', name: 'key-a', masked_key: 'sk-a', group_name: 'default', status: 'active', removed_at: null, rate_multiplier: '0.08' },
          { id: '80', connection_id: '8', name: 'key-b', masked_key: 'sk-b', group_name: 'default', status: 'active', removed_at: null, rate_multiplier: '0.16' },
        ] };
      }
      if (text.includes('FROM "finops".supplier_quality_targets')) {
        return { rows: [
          { id: '1', connection_id: '7', supplier_key_id: '70', model: 'gpt-4o-mini', enabled: true, last_status: 'ok', last_probe_at: observedAt },
          { id: '2', connection_id: '8', supplier_key_id: '80', model: 'gpt-4o-mini', enabled: true, last_status: 'ok', last_probe_at: observedAt },
        ] };
      }
      if (text.includes('FROM "finops".fact_usage_events f')) {
        return { rows: [
          { connection_id: '7', supplier_key_id: '70', model: 'gpt-4o-mini', amount: '120' },
          { connection_id: '8', supplier_key_id: '80', model: 'gpt-4o-mini', amount: '80' },
        ] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const repository = new PostgresRepository(pool, config);
  const overview = await repository.listSupplierQualityOverview();

  assert.equal(overview.items[0].connection.id, 7);
  assert.equal(overview.items[0].metrics.enabledTargetCount, 1);
  assert.equal(overview.items[0].score.priceScore, 100);
  assert.deepEqual(overview.items[0].models, ['gpt-4o-mini']);
  assert.equal(overview.items[1].score.priceScore, 50);
  assert.equal(overview.items[1].score.modelScores[0].keyScores[0].score.bestRateMultiplier, 0.08);
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
    '2026-07-02', '2026-07-30', start, end, 'OpenAI', 20, 0, 'all', false,
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
  assert.match(accounts, /NULLIF\(m\.cost_mode,'unconfigured'\)/);
  assert.match(accounts, /WHEN probe\.status='ok' AND probe\.effective_rate_multiplier>0 AND probe\.fresh_until>NOW\(\) THEN 'probe_multiplier'/);
  assert.match(suppliers, /WHERE p\.status='active' AND p\.effective_from < \$4 AND p\.effective_to > \$3/);
  assert.deepEqual(queries.find((query) => query.text.includes('SELECT p.id,p.source_account_id')).params, [
    start, end, 'OpenAI',
  ]);
});

test('overview omits duplicate consumption rankings and model breakdown exposes displayable model names', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('AS consumption_cny') && text.includes('JOIN "finops".dim_users')) {
        return {
          rows: [{
            id: '7', email: 'customer@example.com', username: 'customer',
            consumption_cny: '18.25', requests: '3', tokens: '2400',
          }],
          rowCount: 1,
        };
      }
      if (text.includes("GROUP BY COALESCE(NULLIF(BTRIM(d.model),''),'未标注模型')")) {
        return {
          rows: [{ name: 'gpt-5.6-sol', consumption_cny: '26.5', requests: '4', tokens: '3200' }],
          rowCount: 1,
        };
      }
      if (text.includes('WITH usage_by_model_account')) {
        return {
          rows: [{
            name: 'gpt-5.6-sol', requests: '4', tokens: '3200', token_list_value_usd: '0.1',
            charge_cny: '26.5', revenue_cny: '26.5', purchase_allocated_cost_cny: '0',
            multiplier_cost_cny: '0', effective_cost_cny: '0', profit_cny: '26.5',
            unbooked_account_count: '0', total_count: '1',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  repository.getSummary = async () => ({ cash: {}, operations: {}, usage: {}, alerts: [] });
  const range = {
    start: new Date('2026-08-02T16:00:00.000Z'), end: new Date('2026-08-03T16:00:00.000Z'),
    dailyStart: '2026-08-03', dailyEnd: '2026-08-03', page: 1, pageSize: 20, offset: 0,
  };

  const [dashboard, models] = await Promise.all([
    repository.getOverviewDashboard(range),
    repository.getUsageBreakdown(range),
  ]);

  assert.equal('userConsumption' in dashboard.rankings, false);
  assert.equal('modelConsumption' in dashboard.rankings, false);
  assert.equal(models.items[0].name, 'gpt-5.6-sol');
  assert.equal(models.items[0].grossMargin, 1);
  assert.equal(queries.filter((query) => query.text.includes('AS consumption_cny')).length, 0);
  const usageBreakdown = queries.find((query) => query.text.includes('WITH usage_by_model_account')).text;
  assert.match(usageBreakdown, /COALESCE\(NULLIF\(BTRIM\(model\),''\),'未标注模型'\) AS model/);
  assert.match(usageBreakdown, /JOIN "finops"\.fact_usage_events f ON f\.source_usage_id=snapshot\.source_usage_id/);
  assert.match(usageBreakdown, /NULLIF\(BTRIM\(f\.requested_model\),''\)/);
  assert.match(usageBreakdown, /SUM\(snapshot\.calculated_cost_cny\) FILTER \(WHERE snapshot\.cost_status='priced'\)/);
  assert.match(usageBreakdown, /SUM\(snapshot\.user_charge_cny\) FILTER \(\s*WHERE snapshot\.cost_status NOT IN \('priced','free','fixed_cost'\)/);
  assert.match(usageBreakdown, /MAX\(snapshot\.cost_mode\) AS cost_mode/);
});

test('runtime dashboard enriches Redis-only concurrency snapshots with FinOps user identities', async () => {
  const queries = [];
  const pool = {
    async query(text) {
      queries.push(text);
      if (text.includes('runtime_queue_live')) return { rows: [], rowCount: 0 };
      if (text.includes('user_concurrency_live')) {
        return {
          rows: [{
            source_user_id: '59', email: 'customer@example.com', username: 'customer',
            max_concurrency: '100', current_concurrency: '2', observed_at: '2026-08-04T02:30:00.000Z',
          }],
          rowCount: 1,
        };
      }
      assert.fail(`unexpected query: ${text}`);
    },
  };
  const repository = new PostgresRepository(pool, config);

  const dashboard = await repository.getRuntimeDashboard();

  assert.equal(dashboard.queue.available, false);
  assert.deepEqual(dashboard.users, [{
    id: 59,
    email: 'customer@example.com',
    username: 'customer',
    maxConcurrency: 100,
    currentConcurrency: 2,
    usagePercent: 2,
    observedAt: '2026-08-04T02:30:00.000Z',
  }]);
  const userQuery = queries.find((text) => text.includes('user_concurrency_live'));
  assert.match(userQuery, /LEFT JOIN "finops"\.dim_users users ON users\.source_user_id=live\.source_user_id/);
  assert.match(userQuery, /COALESCE\(NULLIF\(live\.email,''\),users\.email,''\) AS email/);
});

test('usage event details are read from FinOps facts with searchable model fallback and immutable cost status', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      return {
        rows: [{
          source_usage_id: '42', request_id: 'req-42', occurred_at: '2026-08-03T04:00:00.000Z',
          source_user_id: '7', email: 'customer@example.com', username: 'customer',
          source_account_id: '13', account_name: 'Primary OpenAI', source_group_id: '3', source_channel_id: '5',
          model: 'requested-model', requested_model: 'requested-model', upstream_model: 'upstream-model',
          billing_mode: 'token', billing_type: '0', input_tokens: '100', output_tokens: '20',
          cache_creation_tokens: '5', cache_read_tokens: '10', total_tokens: '135', duration_ms: '3210', first_token_ms: '420',
          standard_cost_usd_reference: '0.012', user_charge_cny: '0.8', recognized_revenue_cny: '0.7',
          cost_mode: 'probe_multiplier', basis_mode: 'revenue_backsolve', cost_status: 'priced',
          calculated_cost_cny: '0.4', selling_multiplier: '1', upstream_multiplier: '0.5',
          cny_per_reference_unit: null, upstream_multiplier_source: 'probe_observation', rate_observation_id: '99',
          snapshot_origin: 'live_sync', cost_snapshot_finalized: true, total_count: '4',
        }],
        rowCount: 1,
      };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const start = new Date('2026-08-02T16:00:00.000Z');
  const end = new Date('2026-08-03T16:00:00.000Z');
  const result = await repository.listUsageEvents({ start, end, search: 'req-42', page: 2, pageSize: 20, offset: 20 });

  assert.equal(result.total, 4);
  assert.equal(result.items[0].model, 'requested-model');
  assert.equal(result.items[0].totalTokens, 135);
  assert.equal(result.items[0].calculatedCostCny, 0.4);
  assert.equal(result.items[0].costSnapshotFinalized, true);
  assert.deepEqual(queries[0].params, [start, end, 'req-42', 20, 20]);
  assert.match(queries[0].text, /FROM "finops"\.fact_usage_events f/);
  assert.match(queries[0].text, /LEFT JOIN "finops"\.fact_usage_cost_snapshots snapshot/);
  assert.match(queries[0].text, /NULLIF\(BTRIM\(f\.requested_model\),''\)/);
  assert.match(queries[0].text, /snapshot\.cost_status/);
  assert.doesNotMatch(queries[0].text, /sub2api/);
});

test('user detail usage rows use the same model fallback as model aggregates', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH totals AS')) {
        return {
          rows: [{
            id: '7', email: 'customer@example.com', username: 'customer', tags: [], status: 'active',
            balance_cny: '0', exclude_from_balance_stats: false, consumption_cny: '0', requests: '0', tokens: '0',
            recharge_cny: '0', credited_cny: '0', admin_credit_cny: '0', admin_deduction_cny: '0',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('WITH days AS')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT source_usage_id,occurred_at,')) {
        return {
          rows: [{
            source_usage_id: '42', occurred_at: '2026-08-03T04:00:00.000Z',
            model: 'requested-model', requested_model: 'requested-model', upstream_model: 'upstream-model',
            source_account_id: '13', user_charge_cny: '0.8', input_tokens: '100', output_tokens: '20',
            cache_creation_tokens: '5', cache_read_tokens: '10', duration_ms: '3210', total_count: '1',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const start = new Date('2026-08-02T16:00:00.000Z');
  const end = new Date('2026-08-03T16:00:00.000Z');
  const details = await repository.getUserDetails({
    userId: 7, start, end, dailyStart: '2026-08-03', dailyEnd: '2026-08-03',
    recharge: { page: 1, pageSize: 20, offset: 0 }, usage: { page: 1, pageSize: 20, offset: 0 },
  });

  assert.equal(details.usage.items[0].model, 'requested-model');
  const usageQuery = queries.find((query) => query.text.includes('SELECT source_usage_id,occurred_at,'));
  assert.match(usageQuery.text, /NULLIF\(BTRIM\(requested_model\),''\)/);
  assert.match(usageQuery.text, /NULLIF\(BTRIM\(upstream_model\),''\)/);
  assert.doesNotMatch(usageQuery.text, /sub2api/);
});

test('overview and gift-credit details exclude affiliate quota records and balance-whitelisted users', async () => {
  const overviewQueries = [];
  const overviewPool = {
    async query(text, params = []) {
      overviewQueries.push({ text, params });
      if (text.includes('gift_balance_credit_cny')) {
        return {
          rows: [{
            gift_balance_credit_cny: '12.5', gift_balance_credit_count: '2',
            balance_cny: '36', balance_user_count: '3',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const overviewRepository = new PostgresRepository(overviewPool, config);
  overviewRepository.getSummary = async () => ({ cash: {}, operations: {}, usage: {}, alerts: [] });
  const start = new Date('2026-08-02T16:00:00.000Z');
  const end = new Date('2026-08-03T16:00:00.000Z');
  const dashboard = await overviewRepository.getOverviewDashboard({
    start, end, dailyStart: '2026-08-03', dailyEnd: '2026-08-03',
  });
  assert.deepEqual(dashboard.totals, {
    giftBalanceCreditCny: 12.5, giftBalanceCreditCount: 2,
    balanceCny: 36, balanceUserCount: 3,
  });
  const overviewTotals = overviewQueries.find((query) => query.text.includes('gift_balance_credit_cny'));
  assert.equal((overviewTotals.text.match(/accounting_scope',''\) <> 'affiliate_quota'/g) || []).length, 2);
  assert.match(overviewTotals.text, /LEFT JOIN "finops"\.dim_users credit_user ON credit_user\.source_user_id=e\.source_user_id/);
  assert.match(overviewTotals.text, /NOT COALESCE\(credit_user\.exclude_from_balance_stats,FALSE\)/);
  assert.match(overviewTotals.text, /SUM\(current_balance\) FILTER \(WHERE current_balance > 0 AND NOT exclude_from_balance_stats\)/);

  const detailQueries = [];
  const detailPool = {
    async query(text, params = []) {
      detailQueries.push({ text, params });
      if (text.includes('COUNT(*) OVER()')) {
        return {
          rows: [{
            id: '7', source_table: 'redeem_codes', source_id: 'CODE-7', event_type: 'redeem',
            credit_amount: '12.5', occurred_at: '2026-08-03T04:00:00.000Z', action: 'used',
            redeem_type: 'balance', email: 'customer@example.com', username: 'customer', total_count: '1',
          }],
          rowCount: 1,
        };
      }
      return { rows: [{ amount_cny: '12.5', events: '1' }], rowCount: 1 };
    },
  };
  const detailRepository = new PostgresRepository(detailPool, config);
  const credits = await detailRepository.listNonCashBalanceCredits({ start, end, page: 1, pageSize: 20, offset: 0 });
  assert.deepEqual(credits.summary, { amountCny: 12.5, events: 1 });
  assert.equal(credits.items[0].id, 7);
  for (const query of detailQueries) {
    assert.match(query.text, /COALESCE\(e\.metadata->>'accounting_scope',''\) <> 'affiliate_quota'/);
    assert.match(query.text, /LEFT JOIN "finops"\.dim_users u ON u\.source_user_id=e\.source_user_id/);
    assert.match(query.text, /NOT COALESCE\(u\.exclude_from_balance_stats,FALSE\)/);
  }
});

test('reported balance scope excludes self-use accounts only from the balance listing', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const range = {
    start: new Date('2026-08-02T16:00:00.000Z'), end: new Date('2026-08-03T16:00:00.000Z'),
    dailyStart: '2026-08-03', dailyEnd: '2026-08-03', search: '', page: 1, pageSize: 20, offset: 0,
  };
  await repository.listUsers({ ...range, balanceScope: 'all' });
  await repository.listUsers({ ...range, balanceScope: 'reported' });
  await repository.listUsers({ ...range, balanceScope: 'whitelist' });
  await repository.listUsers({ ...range, balanceScope: 'all', consumptionOnly: true });
  const userQueries = queries.filter((query) => query.text.includes('usage_by_user_account'));
  assert.equal(userQueries.length, 4);
  assert.equal(userQueries[0].params.at(-2), 'all');
  assert.equal(userQueries[1].params.at(-2), 'reported');
  assert.equal(userQueries[2].params.at(-2), 'whitelist');
  assert.equal(userQueries[3].params.at(-2), 'all');
  assert.equal(userQueries[3].params.at(-1), true);
  assert.match(userQueries[0].text, /\$8='reported' AND u\.current_balance > 0 AND NOT u\.exclude_from_balance_stats/);
  assert.match(userQueries[0].text, /\$8='whitelist' AND u\.exclude_from_balance_stats/);
  assert.match(userQueries[0].text, /NOT \$9::boolean OR COALESCE\(us\.charge_cny,0\)>0/);
  assert.match(userQueries[0].text, /FROM usage_by_user_account u/);
});

test('recharge-scoped cash details and summary include balance recharges and exclude subscription refunds', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT t.id')) {
        return {
          rows: [{
            id: 1, reference: 'ORDER-1', type: 'recharge', direction: 'in', order_type: '', source_status: 'paid',
            method: 'alipay', status: 'confirmed', party: 'customer@example.com', occurred_at: '2026-08-03T04:00:00.000Z',
            base_amount: '10', credited_amount: '10', total_count: '2',
          }],
          rowCount: 1,
        };
      }
      return { rows: [{ inflow: '10', recharge_received: '10', outflow: '2', refunds: '2', transactions: '2' }], rowCount: 1 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const result = await repository.listCashTransactions({
    start: new Date('2026-08-02T16:00:00.000Z'), end: new Date('2026-08-03T16:00:00.000Z'),
    page: 1, pageSize: 20, offset: 0, scope: 'recharge',
  });
  assert.equal(result.items[0].type, 'recharge');
  assert.deepEqual(result.summary, {
    inflow: 10, rechargeReceived: 10, outflow: 2, refunds: 2, net: 8, transactions: 2,
  });
  for (const query of queries) {
    assert.match(query.text, /t\.transaction_type='recharge' OR \(t\.transaction_type='refund' AND COALESCE\(t\.order_type,''\) <> 'subscription'\)/);
    assert.match(query.text, /t\.status <> 'void'/);
  }
});

test('overview summary excludes subscription refunds from recharge net amount', async () => {
  const queries = [];
  const pool = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('FROM account_costs')) {
        return { rows: [{ fixed_cost_cny: '0', multiplier_cost_cny: '0', effective_cost_cny: '0', unbooked_account_count: '0', unbooked_user_charge_cny: '0' }], rowCount: 1 };
      }
      if (text.includes('FROM "finops".fact_usage_events')) {
        return { rows: [{ requests: '0', input_tokens: '0', output_tokens: '0', cache_tokens: '0', active_users: '0', active_accounts: '0', average_latency_ms: '0', user_charge_cny: '0', token_list_value_usd: '0' }], rowCount: 1 };
      }
      if (text.includes('FROM "finops".cash_transactions')) {
        return { rows: [{ inflow: '100', recharge_received: '100', refunds: '15', gateway_fees: '0', procurement_spend: '0', outflow: '15' }], rowCount: 1 };
      }
      return { rows: [{ count: '0' }], rowCount: 1 };
    },
  };
  const repository = new PostgresRepository(pool, config);
  const summary = await repository.getSummary({
    start: new Date('2026-08-02T16:00:00.000Z'), end: new Date('2026-08-03T16:00:00.000Z'),
  });
  assert.equal(summary.cash.refunds, 15);
  const cashQuery = queries.find((query) => query.text.includes('FROM "finops".cash_transactions'));
  assert.match(cashQuery.text, /transaction_type='refund' AND status <> 'void'\s+AND COALESCE\(order_type,''\) <> 'subscription'/);
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

test('started purchase cost edits require an explicit historical correction reason', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT p.*,') && text.includes('FOR UPDATE OF p,a')) {
        return {
          rows: [{
            id: 9, source_account_id: 8, effective_from: '2026-07-01T00:00:00.000Z',
            effective_to: '2026-08-01T00:00:00.000Z', has_started: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  await assert.rejects(
    repository.updateAccountCostPeriod(9, {
      originalAmount: '12', originalCurrency: 'CNY', fxRate: '1', baseAmount: '12',
      feeAmount: '0', taxAmount: '0', supplier: '', purchaseBatch: '',
      effectiveFrom: '2026-07-01T00:00:00.000Z', effectiveTo: '2026-08-01T00:00:00.000Z', notes: '',
      correctionReason: '',
    }),
    (error) => error.statusCode === 409 && /correctionReason/.test(error.message),
  );
  assert.equal(queries.some((query) => query.text.includes('UPDATE "finops".account_cost_periods SET')), false);
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
  assert.match(queries[0].text, /COALESCE\(p\.allocated_cost_cny,p\.base_amount\+p\.fee_amount\+p\.tax_amount\) AS total_cost_cny/);
  assert.doesNotMatch(queries[0].text, /p\.total_cost_cny/);
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
  assert.equal(insert.params[5], null);
  assert.match(queries[0].text, /date_trunc\('day', NOW\(\) AT TIME ZONE \$2\)/);
});

test('strict future-only multiplier starts at the binding instant', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return { rows: [{ now_at: '2026-08-01T04:00:00.000Z', day_start: '2026-07-31T16:00:00.000Z', has_multiplier_before_today: false, first_today_multiplier_rule_id: null }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "finops".account_cost_rules')) return { rows: [{ effective_from: params[7] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const rule = await repository.upsertAccountCostRule(client, 8, {
    costMode: 'probe_multiplier', basisMode: 'revenue_backsolve', supplierKeyId: 77,
    changeStrategy: 'future_only', strictFutureOnly: true,
  });
  assert.equal(rule.effective_from, '2026-08-01T04:00:00.000Z');
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

test('current-day multiplier correction replaces every open version from local midnight', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:00:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: true,
            first_today_multiplier_rule_id: 41,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT *') && text.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 44, cost_profile_id: null, cost_mode: 'manual_multiplier',
            basis_mode: 'revenue_backsolve', upstream_multiplier: '0.05',
            selling_multiplier: '2', cny_per_reference_unit: null, notes: '',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "finops".account_cost_archives')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO "finops".account_cost_rules')) {
        return { rows: [{ effective_from: params[7] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const rule = await repository.upsertAccountCostRule(client, 8, {
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.08', sellingMultiplier: '2', cnyPerReferenceUnit: null,
    changeStrategy: 'current_day', notes: '',
  });
  const voidToday = queries.find((query) => query.text.includes("SET status='void'"));
  const closePrevious = queries.find((query) => query.text.includes('effective_from < $2'));
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_rules'));
  assert.deepEqual(voidToday.params, [8, '2026-07-31T16:00:00.000Z', '2026-08-01T04:00:00.000Z']);
  assert.deepEqual(closePrevious.params, [8, '2026-07-31T16:00:00.000Z', '2026-08-01T04:00:00.000Z']);
  assert.equal(insert.params[7], '2026-07-31T16:00:00.000Z');
  assert.equal(insert.params[10], 'current_day');
  assert.equal(rule.effective_from, '2026-07-31T16:00:00.000Z');
});

test('custom-time multiplier correction replaces the timeline from the exact timestamp', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return {
          rows: [{
            now_at: '2026-08-01T04:00:00.000Z',
            day_start: '2026-07-31T16:00:00.000Z',
            has_multiplier_before_today: true,
            first_today_multiplier_rule_id: 41,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "finops".account_cost_archives')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO "finops".account_cost_rules')) {
        return { rows: [{ effective_from: params[7] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const effectiveFrom = '2026-07-31T18:30:00.000Z';
  const rule = await repository.upsertAccountCostRule(client, 8, {
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.08', cnyPerReferenceUnit: null,
    changeStrategy: 'custom_time', effectiveFrom, notes: '',
  });
  const voidFromCustomTime = queries.find((query) => (
    query.text.includes("SET status='void'") && query.text.includes('effective_from >= $2')
  ));
  const closePrevious = queries.find((query) => (
    query.text.includes('SET effective_to=$2') && query.text.includes('effective_from < $2')
  ));
  const insert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_rules'));
  const repriceQueue = queries.find((query) => query.text.includes('usage_cost_reprice_queue'));
  assert.deepEqual(voidFromCustomTime.params, [8, effectiveFrom, '2026-08-01T04:00:00.000Z']);
  assert.deepEqual(closePrevious.params, [8, effectiveFrom, '2026-08-01T04:00:00.000Z']);
  assert.equal(insert.params[7], effectiveFrom);
  assert.equal(insert.params[10], 'custom_time');
  assert.deepEqual(repriceQueue.params, [8, effectiveFrom]);
  assert.equal(rule.effective_from, effectiveFrom);
});

for (const adapterType of ['sub2api', 'newapi']) test(`linking an active ${adapterType} supplier key creates a key-bound automatic cost rule`, async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('FROM "finops".supplier_keys k') && text.includes('FOR UPDATE OF k')) {
        return {
          rows: [{
            id: '77', connection_id: '9', external_key_id: '596', name: 'upstream-key', masked_key: 'sk-...test',
            status: 'active', removed_at: null, last_check_status: 'ok',
            last_check_at: '2026-08-04T08:00:00.000Z', adapter_type: adapterType,
            detected_adapter_type: adapterType, enabled: true, supplier_name: 'Provider A',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT source_account_id FROM "finops".dim_accounts')) {
        return { rows: [{ source_account_id: '8' }], rowCount: 1 };
      }
      if (text.includes('FROM "finops".supplier_account_links') && text.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM "finops".account_cost_periods')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM "finops".supplier_profit_guard_defaults')) return { rows: [], rowCount: 0 };
      if (text.includes('WITH clock AS') && text.includes('account_cost_rules')) {
        return {
          rows: [{
            now_at: '2026-08-04T08:05:00.000Z',
            day_start: '2026-08-03T16:00:00.000Z',
            has_multiplier_before_today: false,
            first_today_multiplier_rule_id: null,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT *') && text.includes('account_cost_rules') && text.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO "finops".account_cost_rules')) {
        return { rows: [{ id: '55', effective_from: params[7], supplier_key_id: params[11] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);

  const result = await repository.setSupplierKeyAccountLink(77, 8, true, 'finance@example.com');

  assert.equal(result.connectionId, 9);
  assert.equal(result.costMode, 'probe_multiplier');
  assert.equal(result.adapterType, adapterType);
  const linkInsert = queries.find((query) => query.text.includes('INSERT INTO "finops".supplier_account_links'));
  assert.deepEqual(linkInsert.params, [77, 8, 'finance@example.com']);
  const ruleInsert = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_rules'));
  assert.equal(ruleInsert.params[2], 'probe_multiplier');
  assert.equal(ruleInsert.params[11], 77);
  const accountUpdate = queries.find((query) => query.text.includes('SET cost_profile_id=NULL'));
  assert.deepEqual(accountUpdate.params, [8, 'Provider A', 'upstream-key · ID 596']);
});

test('cost archive finalizes only FinOps snapshots and writes an audit event', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT source_account_id') && text.includes('FOR UPDATE')) return { rows: [{ source_account_id: 8 }], rowCount: 1 };
      if (text.includes('SELECT NOW() AS now_at')) return {
        rows: [{ now_at: '2026-08-01T05:00:00.000Z', cutoff_day: '2026-08-01' }], rowCount: 1,
      };
      if (text.includes('FROM "finops".account_cost_archives')) return { rows: [], rowCount: 0 };
      if (text.includes('fact_usage_cost_snapshots')) return { rows: [], rowCount: 3 };
      if (text.includes('account_cost_daily_snapshots')) return { rows: [], rowCount: 2 };
      if (text.includes('INSERT INTO "finops".account_cost_archives')) return {
        rows: [{ id: 9, cutoff_at: '2026-08-01T04:00:00.000Z' }], rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const result = await repository.archiveAccountCost(8, {
    cutoffAt: '2026-08-01T04:00:00.000Z', notes: '日结',
  }, 'finance@example.com');
  assert.deepEqual(result, {
    id: 9, accountId: 8, cutoffAt: '2026-08-01T04:00:00.000Z',
    usageSnapshotCount: 3, fixedCostSnapshotCount: 2,
  });
  const writes = queries.map((query) => query.text).filter((text) => /\b(?:UPDATE|INSERT INTO)\b/.test(text));
  assert.ok(writes.every((text) => !/\b(?:public|sub2api)\./i.test(text)));
  assert.ok(queries.some((query) => query.text.includes("'archive_pricing'")));
});

test('audited reprice updates selected FinOps snapshots and records the before/after totals', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes('SELECT source_account_id') && text.includes('FOR UPDATE')) return { rows: [{ source_account_id: 8 }], rowCount: 1 };
      if (text.includes('SELECT source_usage_id,user_charge_cny')) return {
        rows: [
          {
            source_usage_id: 101, user_charge_cny: '10', standard_cost_usd_reference: '0',
            source_selling_multiplier: '0.1', calculated_cost_cny: '2',
          },
          {
            source_usage_id: 102, user_charge_cny: '20', standard_cost_usd_reference: '0',
            source_selling_multiplier: '0.1', calculated_cost_cny: '4',
          },
        ],
        rowCount: 2,
      };
      if (text.includes('INSERT INTO "finops".account_cost_reprice_jobs')) return {
        rows: [{ id: 12, effective_from: '2026-07-01T00:00:00.000Z', effective_to: '2026-08-01T00:00:00.000Z' }],
        rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const repository = new PostgresRepository({ connect: async () => client }, config);
  const result = await repository.repriceAccountCost(8, {
    effectiveFrom: '2026-07-01T00:00:00.000Z', effectiveTo: '2026-08-01T00:00:00.000Z',
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.05', sellingMultiplier: '8', cnyPerReferenceUnit: null, notes: '更正',
  }, 'finance@example.com');
  assert.deepEqual(result, {
    id: 12, accountId: 8, effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: '2026-08-01T00:00:00.000Z', affectedUsageCount: 2, beforeCostCny: 6, afterCostCny: 15,
  });
  const snapshotUpdate = queries.find((query) => query.text.includes("upstream_multiplier_source='audited_reprice'"));
  assert.ok(snapshotUpdate);
  assert.equal(snapshotUpdate.params[0], 12);
  const repriceJob = queries.find((query) => query.text.includes('INSERT INTO "finops".account_cost_reprice_jobs'));
  assert.equal(repriceJob.params[6], null);
  assert.ok(queries.some((query) => query.text.includes("'historical_reprice'")));
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
