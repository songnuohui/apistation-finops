import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplenishmentRepository } from '../src/repositories/replenishment-repository.mjs';
import { ReplenishmentService } from '../src/services/replenishment-service.mjs';

const config = {
  demoMode: true,
  supplierCredentialsKey: '4a'.repeat(32),
  replenishmentTickSeconds: 30,
};

function authStub() {
  return {
    async loadSettings() {},
    status() {
      return {
        enabled: true,
        credentialsConfigured: true,
        baseUrl: 'https://sogouedu.cc',
      };
    },
    async getAccessToken() {
      return 'customer-token';
    },
  };
}

test('observe mode reports a shortage without creating an order', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.mode = 'observe';
  rule.enabled = true;
  rule.minAvailableAccounts = 3;
  const service = new ReplenishmentService(
    repository,
    authStub(),
    {},
    config,
    console,
    {
      client: {
        async inventory() {
          return { payload: { available: 1, estimated_total_fen: 1000 } };
        },
        async balance() {
          return { payload: { available_fen: 10000 } };
        },
      },
    },
  );

  const result = await service.createOrderForRule(rule);
  assert.equal(result.status, 'observed_need');
  assert.equal((await repository.listOrders()).length, 0);
});

test('replenishment rules reject a missing product mapping before writing', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);

  await assert.rejects(
    repository.saveRule({ ...rule, id: undefined, productMappingId: 9999 }),
    (error) => error?.statusCode === 400 && /商品映射不存在/.test(error.message),
  );
  assert.equal((await repository.listRules()).length, 1);
});

test('product mappings derive their internal pool key from the selected Sub2API groups', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const mapping = await repository.upsertMapping({
    product: 'oauth_30d',
    platform: 'openai',
    targetGroupIds: [9, 3, 9],
    notes: '',
  });

  assert.equal(mapping.targetPoolKey, 'openai:groups:3-9');
  assert.deepEqual(mapping.targetGroupIds, [3, 9]);
});

test('delivery uses per-account charged amount and imports fixed account settings', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.mode = 'auto';
  rule.enabled = true;
  const order = await repository.createPlannedOrder({
    rule,
    trigger: 'manual',
    quantity: 2,
    availableBefore: 0,
    quotedAmountCny: 9,
    actor: 'test',
    status: 'ordering',
    idempotencyKey: 'test-order-1',
  });
  const imports = [];
  const gateway = {
    async importAndVerify(input) {
      await input.onCreated?.(imports.length + 100);
      imports.push(input);
      return { id: imports.length + 99 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, {
    client: {},
  });

  await service.processDelivery(order, rule, {
    order: {
      charged_fen: 900,
      items: [
        { inventory_account_id: 'inventory-1', email: 'one@example.com', charged_fen: 400, remaining_seconds: 3600 },
        { inventory_account_id: 'inventory-2', email: 'two@example.com', charged_fen: 500, remaining_seconds: 7200 },
      ],
    },
    payload: {
      accounts: [
        { email: 'one@example.com', credentials: { access_token: 'one-token' } },
        { email: 'two@example.com', credentials: { access_token: 'two-token' } },
      ],
    },
  });

  const result = await repository.getOrder(order.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.validQuantity, 2);
  assert.deepEqual(result.items.map((item) => item.finalCostCny), [4, 5]);
  assert.deepEqual(imports.map((item) => item.concurrency), [5, 5]);
  assert.deepEqual(imports.map((item) => item.groupIds), [[1], [1]]);
  assert.deepEqual(imports.map((item) => item.priority), [20, 20]);
  assert.equal(imports[0].expiresAt > Math.floor(Date.now() / 1000), true);
});

test('delivery falls back to paid amount divided by valid accounts when item prices are absent', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const order = await repository.createPlannedOrder({
    rule,
    trigger: 'manual',
    quantity: 2,
    availableBefore: 0,
    quotedAmountCny: 9,
    actor: 'test',
    status: 'ordering',
    idempotencyKey: 'test-order-2',
  });
  const gateway = {
    async importAndVerify(input) {
      await input.onCreated?.(importsForAverage.length + 200);
      importsForAverage.push(input);
      return { id: importsForAverage.length + 199 };
    },
  };
  const importsForAverage = [];
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, {
    client: {},
  });

  await service.processDelivery(order, rule, {
    charged_fen: 900,
    accounts: [
      { email: 'one@example.com', credentials: { access_token: 'one-token' } },
      { email: 'two@example.com', credentials: { access_token: 'two-token' } },
    ],
  });

  const result = await repository.getOrder(order.id);
  assert.deepEqual(result.items.map((item) => item.finalCostCny), [4.5, 4.5]);
});

test('cost ledger stays pending until FinOps synchronization exposes the imported account', async () => {
  const item = {
    id: 41,
    orderId: 9,
    sub2apiAccountId: 2780,
    accountName: 'ledger-test@example.com',
    finalCostCny: 12.5,
    verificationStatus: 'passed',
    costLedgerStatus: 'pending',
    metadata: { expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    order: {
      id: 9,
      externalOrderId: 'oauth-order-9',
      product: 'oauth_30d',
      createdAt: new Date().toISOString(),
    },
  };
  const updates = [];
  let accountSynchronized = false;
  let createCount = 0;
  const repository = {
    async listPendingCostItems() {
      return item.costLedgerStatus === 'pending' ? [item] : [];
    },
    async updateOrderItem(id, patch) {
      assert.equal(id, item.id);
      Object.assign(item, patch);
      updates.push({ ...patch });
      return item;
    },
  };
  const ledgerRepository = {
    async listAccountCostPeriods() {
      return {
        items: accountSynchronized
          ? []
          : [],
        total: 0,
        page: 1,
        pageSize: 100,
      };
    },
    async createAccountCostPeriod(input) {
      createCount += 1;
      if (!accountSynchronized) {
        throw Object.assign(new Error('account not found; run synchronization first'), { statusCode: 404 });
      }
      assert.equal(input.accountId, item.sub2apiAccountId);
      assert.equal(input.originalAmount, item.finalCostCny);
      assert.equal(input.purchaseBatch, 'oauth-supply:oauth-order-9');
      return { id: 901 };
    },
  };
  const service = new ReplenishmentService(
    repository,
    authStub(),
    {},
    { ...config, demoMode: false },
    console,
    { client: {}, ledgerRepository },
  );

  await service.reconcileCostLedgers();
  assert.equal(item.costLedgerStatus, 'pending');
  assert.equal(updates.at(-1).costLedgerStatus, 'pending');
  assert.equal(createCount, 1);

  accountSynchronized = true;
  await service.reconcileCostLedgers();
  assert.equal(item.costLedgerStatus, 'recorded');
  assert.equal(item.costLedgerPeriodId, 901);
  assert.equal(createCount, 2);

  await service.reconcileCostLedgers();
  assert.equal(createCount, 2);
});
