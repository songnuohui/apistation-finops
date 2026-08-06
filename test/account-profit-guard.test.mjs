import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountProfitGuardService, groupShouldBeRemoved } from '../src/services/account-profit-guard-service.mjs';
import { Sub2ApiReadonlyGateway } from '../src/services/sub2api-readonly-gateway.mjs';

test('profit guard removes a group when the required margin is no longer available', () => {
  assert.equal(groupShouldBeRemoved(0.085, 0.09, 0.1), true);
  assert.equal(groupShouldBeRemoved(0.085, 0.16, 0.2), false);
  assert.equal(groupShouldBeRemoved(0.16, 0.16, 0), true);
});

test('profit guard re-reads the account and sends only group_ids on a safe update', async () => {
  const calls = [];
  const repository = {
    async recordProfitGuardEvaluation(candidate, details) {
      calls.push({ kind: 'record', candidate, details });
    },
    async recordProfitGuardError() {
      throw new Error('unexpected error');
    },
  };
  const gateway = {
    async getAccount() {
      return { group_ids: [10, 20] };
    },
    async updateAccountGroups(accountId, groupIds) {
      calls.push({ kind: 'update', accountId, groupIds });
    },
  };
  const service = new AccountProfitGuardService(repository, gateway);
  const result = await service.evaluateCandidate({
    accountId: 8, accountName: 'account', supplierKeyId: 7, connectionId: 9,
    upstreamMultiplier: 0.085, minimumMargin: 0.1, allowEmptyGroups: false,
  }, new Map([
    [10, { id: 10, name: 'cheap', rate_multiplier: 0.09 }],
    [20, { id: 20, name: 'safe', rate_multiplier: 0.16 }],
  ]));
  assert.equal(result.changed, true);
  assert.deepEqual(calls.find((item) => item.kind === 'update'), {
    kind: 'update', accountId: 8, groupIds: [20],
  });
  assert.equal(calls.filter((item) => item.kind === 'record').length, 1);
});

test('sub2api group updates bypass the read cache and invalidate account data', async () => {
  const calls = [];
  const gateway = new Sub2ApiReadonlyGateway({
    sub2apiAuthUrl: 'http://127.0.0.1:8080',
    sub2apiAuthTimeoutMs: 1_000,
  }, console, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ code: 0, data: { group_ids: [20] } }), { status: 200 });
  });
  gateway.setAccessToken('token');
  await gateway.getAccount(8);
  await gateway.updateAccountGroups(8, [20]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    group_ids: [20], confirm_mixed_channel_risk: true,
  });
  assert.equal(gateway.cache.has('account:8'), false);
});
