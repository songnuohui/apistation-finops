import test from 'node:test';
import assert from 'node:assert/strict';
import { Sub2ApiReadonlyGateway } from '../src/services/sub2api-readonly-gateway.mjs';
import { SupplierDeletionService } from '../src/services/supplier-deletion-service.mjs';

const config = {
  sub2apiAuthUrl: 'http://127.0.0.1:8080',
  sub2apiAuthTimeoutMs: 1_000,
};

test('Sub2API gateway deletes an account through the administrator API', async () => {
  const calls = [];
  const gateway = new Sub2ApiReadonlyGateway(config, console, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      code: 0,
      data: { message: 'Account deleted successfully' },
    }), { status: 200 });
  });
  gateway.setAccessToken('admin-token');

  const result = await gateway.deleteAccount(42);

  assert.deepEqual(result, { message: 'Account deleted successfully' });
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/admin/accounts/42');
  assert.equal(calls[0].options.method, 'DELETE');
});

test('supplier deletion removes upstream accounts before local records', async () => {
  const events = [];
  const repository = {
    async getSupplierKeyDeletionPlan() {
      return { keyId: 9, accountIds: [42, 43] };
    },
    async deleteSupplierKey(keyId) {
      events.push(['local-delete', keyId]);
      return { keyId, deleted: true };
    },
  };
  const gateway = {
    async deleteAccount(accountId) {
      events.push(['upstream-delete', accountId]);
    },
  };
  const service = new SupplierDeletionService(repository, gateway);

  const result = await service.deleteKey(9, 'admin');

  assert.deepEqual(result, {
    keyId: 9,
    deleted: true,
    deletedAccounts: [
      { accountId: 42, status: 'deleted' },
      { accountId: 43, status: 'deleted' },
    ],
  });
  assert.deepEqual(events, [
    ['upstream-delete', 42],
    ['upstream-delete', 43],
    ['local-delete', 9],
  ]);
});

test('supplier deletion keeps local records when an upstream account deletion fails', async () => {
  let localDeleteCalled = false;
  const repository = {
    async getSupplierConnectionDeletionPlan() {
      return { connectionId: 7, accountIds: [99] };
    },
    async deleteSupplierConnection() {
      localDeleteCalled = true;
      return { connectionId: 7, deleted: true };
    },
  };
  const gateway = {
    async deleteAccount() {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    },
  };
  const service = new SupplierDeletionService(repository, gateway);

  await assert.rejects(() => service.deleteConnection(7), /Sub2API account 99 deletion failed/);
  assert.equal(localDeleteCalled, false);
});

test('already missing upstream accounts are safe to retry', async () => {
  const repository = {
    async getSupplierKeyDeletionPlan() {
      return { keyId: 9, accountIds: [42] };
    },
    async deleteSupplierKey() {
      return { keyId: 9, deleted: true };
    },
  };
  const gateway = {
    async deleteAccount() {
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    },
  };
  const service = new SupplierDeletionService(repository, gateway);

  const result = await service.deleteKey(9);
  assert.deepEqual(result.deletedAccounts, [{ accountId: 42, status: 'already_missing' }]);
});
