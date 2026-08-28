import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceUsageRepository } from '../src/repositories/source-usage-repository.mjs';

function usageRow({
  accountId,
  day,
  model,
  requestedModel = null,
  requests,
  inputTokens,
  outputTokens,
  cacheTokens,
  totalTokens,
  cost,
  actualCost,
}) {
  return {
    account_id: String(accountId),
    day,
    model,
    requested_model: requestedModel,
    requests: String(requests),
    input_tokens: String(inputTokens),
    output_tokens: String(outputTokens),
    cache_tokens: String(cacheTokens),
    total_tokens: String(totalTokens),
    cost: String(cost),
    actual_cost: String(actualCost),
  };
}

test('long-range account and model stats aggregate one local day at a time', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN TRANSACTION READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          usageRow({
            accountId: 1,
            model: 'claude',
            requestedModel: 'gpt-test',
            day: '2026-08-19',
            requests: 2,
            inputTokens: 3,
            outputTokens: 4,
            cacheTokens: 1,
            totalTokens: 8,
            cost: 1,
            actualCost: 2,
          }),
          usageRow({
            accountId: 1,
            model: 'claude',
            requestedModel: 'gpt-test',
            day: '2026-08-20',
            requests: 1,
            inputTokens: 5,
            outputTokens: 6,
            cacheTokens: 2,
            totalTokens: 13,
            cost: 3,
            actualCost: 4,
          }),
          usageRow({
            accountId: 1,
            model: 'gpt-test',
            requestedModel: '',
            day: '2026-08-20',
            requests: 4,
            inputTokens: 7,
            outputTokens: 8,
            cacheTokens: 3,
            totalTokens: 18,
            cost: 5,
            actualCost: 6,
          }),
        ],
        rowCount: 2,
      };
    },
    release() {},
  };
  const repository = new SourceUsageRepository(
    { connect: async () => client },
    {
      sourceSchema: 'public',
      timezone: 'Asia/Shanghai',
      sub2apiUsageCacheTtlSeconds: 30,
    },
  );

  const result = await repository.getDailyAccountAndModelStats({
    start: new Date('2026-08-19T00:00:00+08:00'),
    end: new Date('2026-08-21T00:00:00+08:00'),
  });

  const dataQueries = queries.filter((query) => (
    query.text.includes('FROM "public".usage_logs')
    && query.text.includes('GROUP BY ul.account_id,ul.model,ul.requested_model')
  ));
  assert.equal(dataQueries.length, 1);
  assert.match(dataQueries[0].text, /UNION ALL/);
  assert.equal(dataQueries[0].params.length, 4);
  assert.ok(dataQueries.every((query) => query.text.includes('GROUP BY ul.account_id,ul.model,ul.requested_model')));
  assert.ok(dataQueries.every((query) => !query.text.includes('GROUPING SETS')));
  assert.equal(result.accounts.length, 2);
  assert.equal(result.models.length, 3);
  assert.deepEqual(result.models.map((item) => ({
    day: item.day,
    name: item.dimensionName,
    requests: item.requests,
    tokens: item.totalTokens,
  })), [
    { day: '2026-08-19', name: 'gpt-test', requests: 2, tokens: 8 },
    { day: '2026-08-20', name: 'gpt-test', requests: 1, tokens: 13 },
    { day: '2026-08-20', name: 'unlabeled', requests: 4, tokens: 18 },
  ]);
});

test('long-range user stats aggregate remotely before reading user labels', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text === 'BEGIN TRANSACTION READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM "public".users u')) {
        return {
          rows: [{ id: '7', email: 'user@example.com' }],
          rowCount: 1,
        };
      }
      return {
        rows: [{
          day: '2026-08-19',
          account_id: '1',
          user_id: '7',
          requests: '2',
          input_tokens: '3',
          output_tokens: '4',
          cache_tokens: '1',
          total_tokens: '8',
          cost: '1',
          actual_cost: '2',
        }],
        rowCount: 1,
      };
    },
    release() {},
  };
  const repository = new SourceUsageRepository(
    { connect: async () => client },
    {
      sourceSchema: 'public',
      timezone: 'Asia/Shanghai',
      sub2apiUsageCacheTtlSeconds: 30,
    },
  );

  const result = await repository.getDailyDimensionStats({
    start: new Date('2026-08-19T00:00:00+08:00'),
    end: new Date('2026-08-21T00:00:00+08:00'),
    dimension: 'user',
  });

  const aggregateQuery = queries.find((query) => (
    query.text.includes('FROM "public".usage_logs')
    && query.text.includes('GROUP BY ul.account_id,ul.user_id')
  ));
  const labelQuery = queries.find((query) => query.text.includes('FROM "public".users u'));
  assert.ok(aggregateQuery);
  assert.match(aggregateQuery.text, /UNION ALL/);
  assert.doesNotMatch(aggregateQuery.text, /JOIN "public"\.users/);
  assert.ok(labelQuery);
  assert.deepEqual(labelQuery.params, [[7]]);
  assert.deepEqual(result, [{
    accountId: 1,
    day: '2026-08-19',
    dimensionKey: 7,
    dimensionName: 'user@example.com',
    requests: 2,
    inputTokens: 3,
    outputTokens: 4,
    cacheTokens: 1,
    totalTokens: 8,
    cost: 1,
    actualCost: 2,
  }]);
});
