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
