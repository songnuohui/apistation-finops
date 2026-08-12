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
  const events = await repository.listEvents({ ruleId: rule.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'observed_replenishment');
  assert.match(events[0].message, /观察模式/);
  assert.equal(events[0].details.inventory.trackedAccounts, 0);
  assert.equal(events[0].details.inventory.accounts, undefined);
});

test('blank recovery retry limit is stored as unlimited', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const saved = await repository.saveRule({ ...current, recoveryRetryLimit: '' });

  assert.equal(saved.recoveryRetryLimit, null);
});

test('replenishment schedule accepts daily execution windows and intervals', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const saved = await repository.saveRule({
    ...current,
    scheduleStartTime: '09:30',
    scheduleEndTime: '21:15',
    scheduleIntervalSeconds: 180,
  });

  assert.equal(saved.scheduleStartTime, '09:30');
  assert.equal(saved.scheduleEndTime, '21:15');
  assert.equal(saved.scheduleIntervalSeconds, 180);
});

test('recovery policy is independent from replenishment rule enablement', async () => {
  const repository = new ReplenishmentRepository(null, config);
  await repository.setRuleEnabled(1, false);

  const policy = await repository.saveRecoveryPolicy({
    ruleId: 1, enabled: true, mode: 'auto', retryLimit: null, retryIntervalSeconds: 45,
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.mode, 'auto');
  assert.equal((await repository.getRule(1)).enabled, false);
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

test('replenishment rules can be paused, started, and deleted without losing mappings', async () => {
  const repository = new ReplenishmentRepository(null, config);

  const paused = await repository.setRuleEnabled(1, false);
  assert.equal(paused.enabled, false);
  assert.equal((await repository.listRules({ enabledOnly: true })).length, 0);

  const started = await repository.setRuleEnabled(1, true);
  assert.equal(started.enabled, true);

  await repository.deleteRule(1);
  assert.equal((await repository.listRules()).length, 0);
  assert.equal((await repository.listMappings()).length, 1);
});

test('product mappings cannot be deleted while a live rule still references them', async () => {
  const repository = new ReplenishmentRepository(null, config);

  await assert.rejects(
    repository.deleteMapping(1),
    (error) => error?.statusCode === 409,
  );

  await repository.deleteRule(1);
  await repository.deleteMapping(1);
  assert.equal((await repository.listMappings()).length, 0);
});

test('replenishment rules with active orders cannot be deleted', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  await repository.createPlannedOrder({
    rule,
    trigger: 'manual',
    quantity: 1,
    availableBefore: 0,
    quotedAmountCny: 1,
    actor: 'test',
    status: 'ordering',
    idempotencyKey: 'active-delete-guard',
  });

  await assert.rejects(
    repository.deleteRule(1),
    (error) => error?.statusCode === 409,
  );
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

test('failed verification is queued for a later import retry and can complete without a new order', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.mode = 'auto';
  rule.enabled = true;
  await repository.saveRecoveryPolicy({
    ruleId: rule.id, enabled: true, mode: 'auto', retryLimit: null, retryIntervalSeconds: 15,
  });
  const order = await repository.createPlannedOrder({
    rule, trigger: 'manual', quantity: 1, availableBefore: 0, quotedAmountCny: 3,
    actor: 'test', status: 'ordering', idempotencyKey: 'import-retry-order',
  });
  let shouldFail = true;
  const gateway = {
    async importAndVerify(input) {
      await input.onCreated?.(901);
      if (shouldFail) throw new Error('verification timed out');
      return { id: 901 };
    },
    async configureAndVerify(input) {
      assert.equal(input.accountId, 901);
      if (shouldFail) throw new Error('verification timed out');
      return { id: 901 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });

  await service.processDelivery(order, rule, {
    charged_fen: 300,
    accounts: [{ email: 'retry@example.com', credentials: { access_token: 'retry-token' } }],
  });
  let savedOrder = await repository.getOrder(order.id);
  assert.equal(savedOrder.status, 'import_retry');
  assert.equal(savedOrder.items[0].status, 'retry_wait');
  assert.equal(savedOrder.items[0].sub2apiAccountId, 901);

  shouldFail = false;
  await service.retryImportItem(savedOrder.items[0].id);
  savedOrder = await repository.getOrder(order.id);
  assert.equal(savedOrder.status, 'completed');
  assert.equal(savedOrder.items[0].verificationStatus, 'passed');
  assert.equal(savedOrder.items[0].sub2apiAccountId, 901);
});

test('import retry reimports credentials when the original Sub2API account no longer exists', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  await repository.saveRecoveryPolicy({
    ruleId: rule.id, enabled: true, mode: 'manual', retryLimit: null, retryIntervalSeconds: 15,
  });
  const order = await repository.createPlannedOrder({
    rule, trigger: 'manual', quantity: 1, availableBefore: 0, quotedAmountCny: 3,
    actor: 'test', status: 'ordering', idempotencyKey: 'import-retry-reimport-order',
  });
  let importCount = 0;
  const gateway = {
    async importAndVerify(input) {
      importCount += 1;
      const accountId = importCount === 1 ? 911 : 912;
      await input.onCreated?.(accountId);
      if (importCount === 1) throw new Error('verification timed out');
      return { id: accountId };
    },
    async configureAndVerify() {
      throw Object.assign(new Error('account not found'), { statusCode: 404 });
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });

  await service.processDelivery(order, rule, {
    charged_fen: 300,
    accounts: [{ email: 'missing@example.com', credentials: { access_token: 'retry-token' } }],
  });
  const item = (await repository.getOrder(order.id)).items[0];
  assert.equal(item.sub2apiAccountId, 911);

  await service.retryImportItem(item.id);
  const savedOrder = await repository.getOrder(order.id);
  assert.equal(importCount, 2);
  assert.equal(savedOrder.status, 'completed');
  assert.equal(savedOrder.items[0].sub2apiAccountId, 912);
  assert.equal(savedOrder.items[0].verificationStatus, 'passed');
  assert.ok((await repository.listEvents({ ruleId: rule.id })).some((entry) => entry.eventType === 'import_retry_reimported'));
});

test('invalidated OAuth credentials wait for supplier recovery instead of retrying the same token', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const order = await repository.createPlannedOrder({
    rule, trigger: 'manual', quantity: 1, availableBefore: 0, quotedAmountCny: 3,
    actor: 'test', status: 'ordering', idempotencyKey: 'invalidated-credential-order',
  });
  const gateway = {
    async importAndVerify(input) {
      await input.onCreated?.(921);
      throw new Error('API returned 401: {"code":"token_invalidated"}');
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });

  await service.processDelivery(order, rule, {
    charged_fen: 300,
    accounts: [{ email: 'invalidated@example.com', credentials: { access_token: 'invalidated-token' } }],
  });

  const savedOrder = await repository.getOrder(order.id);
  assert.equal(savedOrder.status, 'import_retry');
  assert.equal(savedOrder.items[0].status, 'waiting_supplier_recovery');
  assert.equal(savedOrder.items[0].nextImportRetryAt, null);
  const [recovery] = await repository.listRecoveries();
  assert.equal(recovery.status, 'waiting_supplier');
  assert.equal(recovery.sub2apiAccountId, 921);
});

test('claimed recovery reimports when the original Sub2API account is gone', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 41, 141);
  await repository.updateOrder(tracked.orderId, { status: 'import_retry', validQuantity: 0 });
  await repository.updateOrderItem(tracked.id, { verificationStatus: 'failed', status: 'waiting_supplier_recovery' });
  let importInput = null;
  const gateway = {
    async applyOAuthCredentials() {
      throw Object.assign(new Error('account not found'), { statusCode: 404 });
    },
    async importAndVerify(input) {
      importInput = input;
      await input.onCreated?.(142);
      return { id: 142 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });
  const job = await repository.upsertRecovery({
    recoveryKey: `item:${tracked.id}:credential:v1`,
    orderItemId: tracked.id,
    ruleId: rule.id,
    sub2apiAccountId: 141,
    accountKey: tracked.externalAccountKey,
    status: 'credentials_saved',
    credentialVersion: 'v2',
    credentialCiphertext: service.vault.encrypt({ credentials: { access_token: 'replacement-token' } }),
  });

  await service.claimRecovery(job.id);

  assert.equal(importInput.platform, 'openai');
  assert.equal(importInput.credentials.access_token, 'replacement-token');
  assert.equal((await repository.getOrderItem(tracked.id)).sub2apiAccountId, 142);
  assert.equal((await repository.getRecovery(job.id)).sub2apiAccountId, 142);
  assert.equal((await repository.getOrder(tracked.orderId)).status, 'completed');
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

async function trackedItem(repository, rule, id, accountId) {
  const order = await repository.createPlannedOrder({
    rule,
    trigger: 'test',
    quantity: 1,
    availableBefore: 0,
    quotedAmountCny: 1,
    actor: 'test',
    status: 'ordering',
    idempotencyKey: `tracked-${id}`,
  });
  await repository.updateOrder(order.id, { status: 'completed', validQuantity: 1 });
  const [created] = await repository.addOrderItems(order.id, [{
    externalItemId: `item-${id}`,
    externalAccountKey: `account-${id}@example.com`,
    accountName: `account-${id}@example.com`,
    verificationStatus: 'passed',
    status: 'imported',
    sub2apiAccountId: accountId,
    credentialVersion: 'v1',
  }]);
  return created;
}

test('effective inventory excludes accounts at the quota threshold and starts recovery for 401 accounts', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.quotaUsedThresholdPercent = 80;
  rule.quotaWindow = 'any';
  await trackedItem(repository, rule, 1, 101);
  await trackedItem(repository, rule, 2, 102);
  await trackedItem(repository, rule, 3, 103);
  const gateway = {
    async getAccount(id) {
      return {
        id,
        platform: 'openai',
        status: 'active',
        schedulable: true,
        group_ids: [1],
        ...(id === 103 ? { error_message: 'upstream returned 401 unauthenticated' } : {}),
      };
    },
    async getAccountUsage(id) {
      return { codex_7d_used_percent: id === 102 ? 80 : 20 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });

  const snapshot = await service.inspectRuleInventory(rule);

  assert.equal(snapshot.trackedAccounts, 3);
  assert.equal(snapshot.effectiveAccounts, 1);
  assert.equal(snapshot.lowQuotaAccounts, 1);
  assert.equal(snapshot.repairingAccounts, 1);
  assert.equal((await repository.listRecoveries()).length, 1);
});

test('only normal and schedulable Sub2API accounts count as effective inventory', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.quotaWindow = 'any';
  rule.quotaUnknownPolicy = 'ignore';
  for (const [id, accountId] of [[31, 131], [32, 132], [33, 133], [34, 134], [35, 135]]) {
    await trackedItem(repository, rule, id, accountId);
  }
  const accounts = new Map([
    [131, { status: 'active', schedulable: true }],
    [132, { status: 'active', schedulable: false }],
    [133, { status: 'active' }],
    [134, { status: 'inactive', schedulable: true }],
    [135, { status: 'error', schedulable: true }],
  ]);
  const gateway = {
    async getAccount(id) {
      return { id, platform: 'openai', group_ids: [1], ...accounts.get(id) };
    },
    async getAccountUsage() {
      return { codex_7d_used_percent: 20 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, { client: {} });

  const snapshot = await service.inspectRuleInventory(rule);

  assert.equal(snapshot.effectiveAccounts, 1);
  assert.equal(snapshot.unavailableAccounts, 4);
  assert.deepEqual(snapshot.accounts.map((account) => account.schedulable), [true, false, false, true, true]);
});

test('inventory at the inclusive threshold orders only enough to reach the target', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.mode = 'observe';
  rule.minAvailableAccounts = 2;
  rule.targetAvailableAccounts = 5;
  rule.replenishQuantity = 3;
  await trackedItem(repository, rule, 4, 104);
  await trackedItem(repository, rule, 5, 105);
  rule.lastTriggeredAt = null;
  const gateway = {
    async getAccount(id) {
      return { id, platform: 'openai', status: 'active', schedulable: true, group_ids: [1] };
    },
    async getAccountUsage() {
      return { codex_5h_used_percent: 10, codex_7d_used_percent: 20 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, {
    client: {
      async inventory({ quantity }) {
        assert.equal(quantity, 3);
        return { payload: { available: 10, estimated_total_fen: 900 } };
      },
    },
  });

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'observed_need');
  assert.equal(result.available, 2);
  assert.equal(result.quantity, 3);
});

test('recovery saves claimed credentials before retrying Sub2API and verifies the same account', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 6, 106);
  let claimCalls = 0;
  let applyFails = true;
  const gateway = {
    async applyOAuthCredentials(id, credentials) {
      assert.equal(id, 106);
      assert.equal(credentials.access_token, 'repaired-token');
      if (applyFails) throw new Error('temporary Sub2API failure');
    },
    async testAccount(id) {
      assert.equal(id, 106);
      return { success: true };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, {
    client: {
      async claimRecovery() {
        claimCalls += 1;
        return { payload: { credentials: { access_token: 'repaired-token' }, credential_version: 'v2' } };
      },
    },
  });
  const job = await repository.upsertRecovery({
    recoveryKey: `item:${tracked.id}:credential:v1`,
    supplierRecoveryId: 'recovery-6',
    orderItemId: tracked.id,
    ruleId: rule.id,
    sub2apiAccountId: 106,
    accountKey: tracked.externalAccountKey,
    status: 'claimable',
    attemptCount: 20,
    claimUrlCiphertext: service.vault.encrypt({ claimUrl: '/api/customer/recoveries/6/claim?ticket=ticket' }),
  });

  await assert.rejects(service.claimRecovery(job.id), /temporary Sub2API failure/);
  let saved = await repository.getRecovery(job.id);
  assert.equal(saved.status, 'retry_wait');
  assert.equal(saved.attemptCount, 21);
  assert.ok(saved.credentialCiphertext);
  assert.equal(claimCalls, 1);

  applyFails = false;
  await service.claimRecovery(job.id);
  saved = await repository.getRecovery(job.id);
  assert.equal(saved.status, 'recovered');
  assert.equal(saved.credentialVersion, 'v2');
  assert.equal(claimCalls, 1);
  assert.equal((await repository.getOrderItem(tracked.id)).verificationStatus, 'repaired');
});
