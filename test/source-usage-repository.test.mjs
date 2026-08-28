import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceUsageRepository } from '../src/repositories/source-usage-repository.mjs';

function usageRow({
  accountId,
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
      const day = new Date(params[1]).toISOString().slice(0, 10);
      if (day === '2026-08-19') {
        return {
          rows: [
            usageRow({
              accountId: 1,
              model: 'claude',
              requestedModel: 'gpt-test',
              requests: 2,
              inputTokens: 3,
              outputTokens: 4,
              cacheTokens: 1,
              totalTokens: 8,
              cost: 1,
              actualCost: 2,
            }),
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          usageRow({
            accountId: 1,
            model: 'claude',
            requestedModel: 'gpt-test',
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
  assert.equal(dataQueries.length, 2);
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
