import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountProfitGuardService,
  groupShouldBeRemoved,
  minimumSaleMultiplierForMargin,
} from '../src/services/account-profit-guard-service.mjs';
import { Sub2ApiReadonlyGateway } from '../src/services/sub2api-readonly-gateway.mjs';

test('profit guard removes a group when the required margin is no longer available', () => {
  assert.equal(groupShouldBeRemoved(0.085, 0.09, 0.1), true);
  assert.equal(groupShouldBeRemoved(0.085, 0.16, 0.2), false);
  assert.equal(groupShouldBeRemoved(0.16, 0.16, 0), true);
});

test('profit guard supports an upstream cost trigger multiplier', () => {
  assert.equal(minimumSaleMultiplierForMargin(0.085, 0.2), 0.10625);
  assert.equal(groupShouldBeRemoved(0.06, 0.08, 0, 'minimum_sale_multiplier', 0.085), false);
  assert.equal(groupShouldBeRemoved(0.085, 0.08, 0, 'minimum_sale_multiplier', 0.085), true);
  assert.equal(groupShouldBeRemoved(0.085, 0.09, 0, 'minimum_sale_multiplier', 0.085), false);
  assert.equal(groupShouldBeRemoved(0.075, 0.08, 0, 'minimum_sale_multiplier', 0.07), false);
  assert.equal(groupShouldBeRemoved(0.08, 0.08, 0, 'minimum_sale_multiplier', 0.01), true);
});

test('profit guard re-reads the account and sends only group_ids on a safe update', async () => {
  const calls = [];
  const readOptions = [];
  const repository = {
    async recordProfitGuardEvaluation(candidate, details) {
      calls.push({ kind: 'record', candidate, details });
    },
    async recordProfitGuardError() {
      throw new Error('unexpected error');
    },
  };
  const gateway = {
    async getAccount(_accountId, options) {
      readOptions.push(options);
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
  assert.deepEqual(readOptions, [{ fresh: true }, { fresh: true }]);
  assert.equal(calls.filter((item) => item.kind === 'record').length, 1);
  assert.equal(calls.find((item) => item.kind === 'record').details.groupName, 'cheap');
  assert.match(calls.find((item) => item.kind === 'record').details.reason, /分组“cheap”/);
});

test('profit guard auto-assigns only platform-matched groups within the inclusive margin range', async () => {
  const calls = [];
  const repository = {
    async recordProfitGuardEvaluation(_candidate, details) { if (details?.action) calls.push(details); },
    async recordProfitGuardError() {},
  };
  const gateway = {
    async getAccount() { return { group_ids: [10] }; },
    async updateAccountGroups(_accountId, groupIds) { calls.push({ action: 'update', groupIds }); },
  };
  const service = new AccountProfitGuardService(repository, gateway);
  const result = await service.evaluateCandidate({
    accountId: 8, accountName: 'OpenAI account', platform: 'OpenAI', supplierKeyId: 7, connectionId: 9,
    upstreamMultiplier: 0.06, minimumMargin: 0.3, allowEmptyGroups: true,
    autoAssignEnabled: true, targetMarginMin: 0.2, targetMarginMax: 0.25,
  }, new Map([
    [10, { id: 10, name: 'existing', platform: 'openai', rate_multiplier: 0.09 }],
    [20, { id: 20, name: 'boundary-low', platform: 'OpenAI', rate_multiplier: 0.075 }],
    [30, { id: 30, name: 'boundary-high', platform: 'openai', rate_multiplier: 0.08 }],
    [40, { id: 40, name: 'wrong-platform', platform: 'claude_code', rate_multiplier: 0.08 }],
    [50, { id: 50, name: 'outside-range', platform: 'openai', rate_multiplier: 0.1 }],
  ]));
  assert.equal(result.changed, true);
  assert.deepEqual(calls.find((item) => item.action === 'update'), { action: 'update', groupIds: [10, 20, 30] });
  assert.deepEqual(calls.filter((item) => item.action === 'add_group').map((item) => item.groupId), [20, 30]);
  assert.deepEqual(calls.filter((item) => item.action === 'add_group').map((item) => item.groupName), ['boundary-low', 'boundary-high']);
  assert.ok(calls.filter((item) => item.action === 'add_group').every((item) => /分组“/.test(item.reason)));
});

test('target margin range adds preferred groups without removing a safe existing group below the target range', async () => {
  const updates = [];
  const repository = {
    async recordProfitGuardEvaluation() {},
    async recordProfitGuardError() {},
  };
  const gateway = {
    async getAccount() { return { group_ids: [10] }; },
    async updateAccountGroups(_accountId, groupIds) { updates.push(groupIds); },
  };
  const service = new AccountProfitGuardService(repository, gateway);
  const result = await service.evaluateCandidate({
    accountId: 8,
    platform: 'openai',
    upstreamMultiplier: 0.085,
    minimumMargin: 0.1,
    allowEmptyGroups: true,
    autoAssignEnabled: true,
    targetMarginMin: 0.2,
    targetMarginMax: 0.35,
  }, new Map([
    [10, { id: 10, platform: 'openai', rate_multiplier: 0.1 }],
    [20, { id: 20, platform: 'openai', rate_multiplier: 0.12 }],
  ]));
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.added, [20]);
  assert.deepEqual(updates, [[10, 20]]);
});

test('profit guard applies removals and auto-assignment in one update', async () => {
  const updates = [];
  const repository = {
    async recordProfitGuardEvaluation() {},
    async recordProfitGuardError() {},
  };
  const gateway = {
    async getAccount() { return { group_ids: [10, 20] }; },
    async updateAccountGroups(_accountId, groupIds) { updates.push(groupIds); },
  };
  const service = new AccountProfitGuardService(repository, gateway);
  await service.evaluateCandidate({
    accountId: 8, platform: 'openai', upstreamMultiplier: 0.085, minimumMargin: 0.1,
    allowEmptyGroups: true, autoAssignEnabled: true, targetMarginMin: 0.1, targetMarginMax: 0.3,
  }, new Map([
    [10, { id: 10, platform: 'openai', rate_multiplier: 0.09 }],
    [20, { id: 20, platform: 'openai', rate_multiplier: 0.16 }],
    [30, { id: 30, platform: 'openai', rate_multiplier: 0.1 }],
  ]));
  assert.deepEqual(updates, [[20, 30]]);
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

test('group account lookup uses the read-only filtered account list with a bounded page size', async () => {
  const calls = [];
  const gateway = new Sub2ApiReadonlyGateway({
    sub2apiAuthUrl: 'http://127.0.0.1:8080',
    sub2apiAuthTimeoutMs: 1_000,
  }, console, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
  });
  gateway.setAccessToken('token');
  await gateway.listAccounts({ group: '12', page: 2, pageSize: 500, search: 'oauth', status: '' });
  const request = new URL(calls[0].url);
  assert.equal(request.pathname, '/api/v1/admin/accounts');
  assert.equal(request.searchParams.get('group'), '12');
  assert.equal(request.searchParams.get('page'), '2');
  assert.equal(request.searchParams.get('page_size'), '100');
  assert.equal(request.searchParams.get('search'), 'oauth');
  assert.equal(request.searchParams.get('lite'), 'true');
  assert.equal(calls[0].options.method, 'GET');
});
