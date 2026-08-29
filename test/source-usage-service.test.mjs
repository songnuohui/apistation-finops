import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceUsageService } from '../src/services/source-usage-service.mjs';

const input = {
  start: new Date('2026-08-20T00:00:00+08:00'),
  end: new Date('2026-08-21T00:00:00+08:00'),
  dailyStart: '2026-08-20',
  dailyEnd: '2026-08-20',
  page: 1,
  pageSize: 10,
  offset: 0,
  sort: 'requests',
  direction: 'desc',
};

function localRepository() {
  return {
    async getAccountCostingProfiles() {
      return [{ id: 1, costMode: 'free', costType: 'free' }];
    },
    async getAccountCostRateTimelines() {
      return new Map([[1, []]]);
    },
  };
}

function rows() {
  return {
    accounts: [{
      accountId: 1,
      day: '2026-08-20',
      requests: 2,
      inputTokens: 3,
      outputTokens: 4,
      cacheTokens: 1,
      totalTokens: 8,
      cost: 1,
      actualCost: 2,
    }],
    models: [{
      accountId: 1,
      day: '2026-08-20',
      dimensionKey: 'gpt-test',
      dimensionName: 'gpt-test',
      requests: 2,
      inputTokens: 3,
      outputTokens: 4,
      cacheTokens: 1,
      totalTokens: 8,
      cost: 1,
      actualCost: 2,
    }],
  };
}

test('overview economics and model usage share one combined source aggregation', async () => {
  let calls = 0;
  const source = {
    async getDailyAccountAndModelStats() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return rows();
    },
  };
  const service = new SourceUsageService(
    localRepository(),
    {},
    { timezone: 'Asia/Shanghai' },
    source,
    { warn() {} },
  );

  const [first, second, models] = await Promise.all([
    service.getSourceEconomics(input),
    service.getSourceEconomics(input),
    service.getUsageBreakdown(input),
  ]);

  assert.equal(calls, 1);
  assert.equal(first.total_requests, 2);
  assert.equal(second.total_actual_cost, 2);
  assert.equal(models.total, 1);
  assert.equal(models.items[0].name, 'gpt-test');
  assert.equal(models.items[0].requests, 2);
});

test('source usage service falls back to separate repository methods for older adapters', async () => {
  let accountCalls = 0;
  let modelCalls = 0;
  const source = {
    async getDailyAccountGroupStats() {
      accountCalls += 1;
      return rows().accounts;
    },
    async getDailyDimensionStats({ dimension }) {
      assert.equal(dimension, 'model');
      modelCalls += 1;
      return rows().models;
    },
  };
  const service = new SourceUsageService(
    localRepository(),
    {},
    { timezone: 'Asia/Shanghai' },
    source,
    { warn() {} },
  );

  const [summary, models] = await Promise.all([
    service.getSourceEconomics(input),
    service.getUsageBreakdown(input),
  ]);

  assert.equal(accountCalls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(summary.total_tokens, 8);
  assert.equal(models.items[0].name, 'gpt-test');
});

test('user finance summary excludes every metric from balance-whitelisted users', async () => {
  const repository = {
    ...localRepository(),
    async listUsers() {
      return {
        items: [
          { id: 1, email: 'customer@example.com', balanceCny: 50, cashPaidCny: 10, excludeFromBalanceStats: false },
          { id: 2, email: 'internal@example.com', balanceCny: 900, cashPaidCny: 100, excludeFromBalanceStats: true },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      };
    },
  };
  const source = {
    async getDailyDimensionStats({ dimension }) {
      assert.equal(dimension, 'user');
      return [
        {
          accountId: 1, day: '2026-08-20', dimensionKey: '1', dimensionName: 'customer@example.com',
          requests: 3, inputTokens: 4, outputTokens: 5, cacheTokens: 0, totalTokens: 9, cost: 1, actualCost: 2,
        },
        {
          accountId: 1, day: '2026-08-20', dimensionKey: '2', dimensionName: 'internal@example.com',
          requests: 30, inputTokens: 40, outputTokens: 50, cacheTokens: 0, totalTokens: 90, cost: 10, actualCost: 20,
        },
      ];
    },
  };
  const service = new SourceUsageService(
    repository,
    {},
    { timezone: 'Asia/Shanghai' },
    source,
    { warn() {} },
  );

  const result = await service.listUsers({
    ...input,
    search: '',
    balanceScope: 'all',
    consumptionOnly: false,
  });
  const cashDetail = await service.listUsers({
    ...input,
    search: '',
    balanceScope: 'all',
    financeScope: 'cash',
    consumptionOnly: false,
  });

  assert.equal(result.summary.userCount, 1);
  assert.equal(result.summary.excludedUserCount, 1);
  assert.equal(result.summary.remainingBalanceCny, 50);
  assert.equal(result.summary.cashPaidCny, 10);
  assert.equal(result.summary.userChargeCny, 2);
  assert.equal(result.summary.requests, 3);
  assert.equal(result.summary.bookedCostCny, 0);
  assert.equal(result.summary.bookedProfitCny, 2);
  assert.equal(result.summary.grossMargin, 1);
  assert.equal(cashDetail.total, 1);
  assert.equal(cashDetail.items[0].email, 'customer@example.com');
  assert.equal(cashDetail.items[0].excludeFromBalanceStats, false);
  assert.equal(cashDetail.summary.cashPaidCny, 10);
});
