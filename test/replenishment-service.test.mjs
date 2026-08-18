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

test('replenishment trigger strategy is validated and stored', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const saved = await repository.saveRule({ ...current, triggerStrategy: 'fixed_schedule' });

  assert.equal(saved.triggerStrategy, 'fixed_schedule');
  const smart = await repository.saveRule({
    ...current,
    triggerStrategy: 'smart_forecast',
    scheduleIntervalSeconds: 300,
  });
  assert.equal(smart.triggerStrategy, 'smart_forecast');
  assert.equal(smart.quotaWindow, 'long');
  await assert.rejects(
    repository.saveRule({ ...current, triggerStrategy: 'unknown' }),
    /补号方式无效/,
  );
});

test('smart replenishment normalizes user-entered forecast controls to adaptive defaults', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const saved = await repository.saveRule({
    ...current,
    triggerStrategy: 'smart_forecast',
    minAvailableAccounts: 3,
    targetAvailableAccounts: 99,
    repairGraceSeconds: 900,
    scheduleIntervalSeconds: 30,
    forecastLookbackHours: 24,
    forecastCoverageHours: 72,
    forecastSafetyFactor: 2,
    forecastFallbackLeadTimeHours: 12,
    forecastDefaultAccountCapacity: 500,
  });

  assert.equal(saved.targetAvailableAccounts, 3);
  assert.equal(saved.repairGraceSeconds, 0);
  assert.equal(saved.scheduleIntervalSeconds, 300);
  assert.equal(saved.forecastLookbackHours, 168);
  assert.equal(saved.forecastDefaultAccountCapacity, null);
});

test('smart replenishment forecasts finite quota demand without creating an order in observe mode', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, {
    mode: 'observe',
    enabled: true,
    triggerStrategy: 'smart_forecast',
    scheduleIntervalSeconds: 300,
    forecastLookbackHours: 48,
    forecastCoverageHours: 24,
    forecastSafetyFactor: 1.2,
    forecastFallbackLeadTimeHours: 2,
    replenishQuantity: 5,
  });
  const nowMs = Date.parse('2026-08-18T12:30:00.000Z');
  const usageRows = [];
  for (let offset = 1; offset <= 48; offset += 1) {
    const hour = new Date(Math.floor(nowMs / 3_600_000) * 3_600_000 - offset * 3_600_000).toISOString();
    for (const accountId of [101, 102, 103]) {
      usageRows.push({ accountId, hour, cost: 4 });
    }
  }
  const accounts = [101, 102, 103].map((id, index) => ({
    id,
    platform: 'openai',
    status: 'active',
    schedulable: true,
    group_ids: [1],
    extra: { codex_7d_used_percent: 90 + index * 5 },
  }));
  const service = new ReplenishmentService(
    repository,
    authStub(),
    {},
    config,
    console,
    {
      now: () => nowMs,
      sourceUsageRepository: {
        async getHourlyAccountStats() {
          return usageRows;
        },
      },
      accountReader: {
        async listAllAccounts() {
          return accounts;
        },
      },
      client: {
        async inventory() {
          return { payload: { available: 20, estimated_total_fen: 2000 } };
        },
      },
    },
  );

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'observed_need');
  assert.ok(result.forecast.forecastUsage > 0);
  assert.ok(result.forecast.conservativeAccountCapacity > 0);
  assert.ok(result.forecast.recommendedQuantity > 0);
  assert.equal(result.forecast.parameterMode, 'adaptive');
  assert.ok([24, 72, 168].includes(result.forecast.lookbackHours));
  assert.ok([300, 600, 900, 1800].includes(result.forecast.nextCheckSeconds));
  assert.equal((await repository.listOrders()).length, 0);
});

test('replenishment thresholds allow equal minimum and target at the new lower bounds', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const saved = await repository.saveRule({
    ...current,
    minAvailableAccounts: 1,
    targetAvailableAccounts: 1,
    scheduleIntervalSeconds: 3,
    loadFactor: 25,
    proxyId: 44,
    rateMultiplier: 0.75,
    autoPauseOnExpired: false,
  });

  assert.equal(saved.minAvailableAccounts, 1);
  assert.equal(saved.targetAvailableAccounts, 1);
  assert.equal(saved.scheduleIntervalSeconds, 3);
  assert.equal(saved.loadFactor, 25);
  assert.equal(saved.proxyId, 44);
  assert.equal(saved.rateMultiplier, 0.75);
  assert.equal(saved.autoPauseOnExpired, false);
});

test('replenishment thresholds reject values below the new lower bounds', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  await assert.rejects(
    repository.saveRule({ ...current, minAvailableAccounts: 0 }),
    (error) => error?.statusCode === 400 && /1/.test(error.message),
  );
  await assert.rejects(
    repository.saveRule({ ...current, minAvailableAccounts: 2, targetAvailableAccounts: 1 }),
    (error) => error?.statusCode === 400 && /不能低于/.test(error.message),
  );
  await assert.rejects(
    repository.saveRule({ ...current, scheduleIntervalSeconds: 2 }),
    (error) => error?.statusCode === 400 && /3/.test(error.message),
  );
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
  assert.deepEqual(imports.map((item) => item.loadFactor), [null, null]);
  assert.deepEqual(imports.map((item) => item.rateMultiplier), [1, 1]);
  assert.deepEqual(imports.map((item) => item.autoPauseOnExpired), [true, true]);
  assert.equal(imports[0].expiresAt > Math.floor(Date.now() / 1000), true);
});

test('delivery distributes the paid amount exactly across all delivered accounts when item prices are absent', async () => {
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

test('replenishment model whitelist is normalized and empty means unrestricted', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const current = await repository.getRule(1);

  const restricted = await repository.saveRule({
    ...current,
    modelWhitelist: ['gpt-5.6', ' gpt-5.2 ', 'gpt-5.6', ''],
  });
  assert.deepEqual(restricted.modelWhitelist, ['gpt-5.6', 'gpt-5.2']);

  const unrestricted = await repository.saveRule({ ...restricted, modelWhitelist: [] });
  assert.deepEqual(unrestricted.modelWhitelist, []);
});

test('delivery assigns cost to a temporarily failed account without requiring manual cost entry', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const order = await repository.createPlannedOrder({
    rule, trigger: 'manual', quantity: 3, availableBefore: 0, quotedAmountCny: 10,
    actor: 'test', status: 'ordering', idempotencyKey: 'failed-cost-order',
  });
  let calls = 0;
  const service = new ReplenishmentService(repository, authStub(), {
    async importAndVerify(input) {
      calls += 1;
      await input.onCreated?.(300 + calls);
      if (calls === 2) throw new Error('verification timed out');
      return { id: 300 + calls };
    },
  }, config, console, { client: {} });

  await service.processDelivery(order, rule, {
    charged_fen: 1000,
    accounts: [
      { email: 'one@example.com', credentials: { access_token: 'one' } },
      { email: 'two@example.com', credentials: { access_token: 'two' } },
      { email: 'three@example.com', credentials: { access_token: 'three' } },
    ],
  });

  const saved = await repository.getOrder(order.id);
  assert.deepEqual(saved.items.map((item) => item.finalCostCny), [3.34, 3.33, 3.33]);
  assert.equal(saved.items.reduce((sum, item) => sum + item.finalCostCny, 0), 10);
  assert.equal(saved.items[1].verificationStatus, 'failed');
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
    async applyOAuthCredentials(id, credentials) {
      assert.equal(id, 901);
      assert.equal(credentials.access_token, 'retry-token');
    },
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
    async applyOAuthCredentials(id, credentials) {
      assert.equal(id, 911);
      assert.equal(credentials.access_token, 'retry-token');
    },
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
    async applyOAuthCredentials(id, credentials) {
      assert.equal(id, 911);
      assert.equal(credentials.access_token, 'retry-token');
    },
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

test('repaired and previously failed cost items are automatically retried with the order cost fallback', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 81, 281);
  await repository.updateOrder(tracked.orderId, {
    externalOrderId: '60881', deliveredQuantity: 1, actualPaidAmountCny: 2.64,
  });
  await repository.updateOrderItem(tracked.id, {
    verificationStatus: 'repaired', finalCostCny: null, individualCostCny: null,
    costLedgerStatus: 'failed', costLedgerError: 'previous synchronization failure',
  });

  const [pending] = await repository.listPendingCostItems();

  assert.equal(pending.id, tracked.id);
  assert.equal(pending.finalCostCny, 2.64);
  assert.equal(pending.persistedFinalCostCny, null);
  assert.equal(pending.order.externalOrderId, '60881');
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

test('a transient Sub2API read failure keeps the last known healthy account in inventory', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  rule.scheduleIntervalSeconds = 3;
  const tracked = await trackedItem(repository, rule, 36, 136);
  let now = Date.parse('2026-08-15T12:00:00Z');
  let readable = true;
  const gateway = {
    async getAccount(id) {
      if (!readable) throw Object.assign(new Error('Sub2API temporarily unavailable'), { statusCode: 503 });
      return { id, platform: 'openai', status: 'active', schedulable: true, group_ids: [1] };
    },
    async getAccountUsage() {
      return { codex_7d_used_percent: 20 };
    },
  };
  const service = new ReplenishmentService(repository, authStub(), gateway, config, console, {
    client: {},
    now: () => now,
  });

  assert.equal((await service.inspectRuleInventory(rule)).effectiveAccounts, 1);
  readable = false;
  now += 10_000;
  const duringFailure = await service.inspectRuleInventory(rule);
  assert.equal(duringFailure.effectiveAccounts, 1);
  assert.equal(duringFailure.accounts[0].staleHealthy, true);
  assert.equal(duringFailure.accounts[0].healthStatus, 'healthy');

  now += 31_000;
  const afterGrace = await service.inspectRuleInventory(rule);
  assert.equal(afterGrace.effectiveAccounts, 0);
  assert.equal(afterGrace.accounts[0].staleHealthy, false);
  assert.equal(afterGrace.accounts[0].healthStatus, 'unavailable');
  assert.equal((await repository.getOrderItem(tracked.id)).healthStatus, 'unavailable');
});

test('inventory exactly at the minimum threshold does not replenish', async () => {
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
    client: { async inventory() { throw new Error('inventory should not be queried'); } },
  });

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'healthy');
  assert.equal(result.available, 2);
});

test('inventory strategy reserves grace repairs and pending accounts before sizing an order', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, {
    mode: 'observe',
    triggerStrategy: 'inventory_threshold',
    minAvailableAccounts: 3,
    targetAvailableAccounts: 5,
    replenishQuantity: 10,
  });
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async inventory({ quantity }) {
        assert.equal(quantity, 3);
        return { payload: { available: 20, estimated_total_fen: 300 } };
      },
    },
  });
  service.inspectRuleInventory = async () => ({
    capturedAt: new Date().toISOString(), trackedAccounts: 2, effectiveAccounts: 0,
    lowQuotaAccounts: 0, unavailableAccounts: 0, repairingAccounts: 1,
    graceRepairingAccounts: 1, unknownQuotaAccounts: 0, pendingAccounts: 1, accounts: [],
  });

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'observed_need');
  assert.equal(result.quantity, 3);
});

test('an expired repair grace no longer reserves inventory', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, {
    mode: 'observe', triggerStrategy: 'inventory_threshold', minAvailableAccounts: 1,
    targetAvailableAccounts: 1, replenishQuantity: 1,
  });
  let inventoryCalls = 0;
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async inventory() {
        inventoryCalls += 1;
        return { payload: { available: 5, estimated_total_fen: 100 } };
      },
    },
  });
  service.inspectRuleInventory = async () => ({
    capturedAt: new Date().toISOString(), trackedAccounts: 1, effectiveAccounts: 0,
    lowQuotaAccounts: 0, unavailableAccounts: 0, repairingAccounts: 1,
    graceRepairingAccounts: 0, unknownQuotaAccounts: 0, pendingAccounts: 0, accounts: [],
  });

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'observed_need');
  assert.equal(result.quantity, 1);
  assert.equal(inventoryCalls, 1);
});

test('fixed schedule buys the configured quantity without inspecting Sub2API inventory', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, {
    mode: 'approval', triggerStrategy: 'fixed_schedule', replenishQuantity: 4,
  });
  const service = new ReplenishmentService(repository, authStub(), {
    async getAccount() { throw new Error('Sub2API inventory must not be inspected'); },
  }, config, console, {
    client: {
      async inventory({ quantity }) {
        assert.equal(quantity, 4);
        return { payload: { available: 10, estimated_total_fen: 400 } };
      },
      async balance() { return { payload: { available_fen: 10000 } }; },
    },
    now: () => Date.parse('2026-08-16T12:00:01Z'),
  });
  service.inspectRuleInventory = async () => { throw new Error('target inventory must not be inspected'); };

  const result = await service.createOrderForRule(rule, {
    scheduledFor: '2026-08-16T12:00:00.000Z',
  });

  assert.equal(result.requestedQuantity, 4);
  assert.equal(result.availableBefore ?? null, null);
  assert.equal((await repository.listOrders()).length, 1);
});

test('fixed schedule skips an active order before querying supplier inventory', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, { mode: 'approval', triggerStrategy: 'fixed_schedule', replenishQuantity: 2 });
  await repository.createPlannedOrder({
    rule, trigger: 'manual', quantity: 2, availableBefore: null, quotedAmountCny: 2,
    actor: 'test', status: 'approval_required', idempotencyKey: 'fixed-active-order',
  });
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async inventory() { throw new Error('supplier inventory must not be queried'); },
    },
  });

  const result = await service.createOrderForRule(rule);

  assert.equal(result.status, 'already_active');
  assert.equal((await repository.listOrders()).length, 1);
});

test('scheduled replenishment is idempotent for the same execution slot', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  Object.assign(rule, { mode: 'approval', triggerStrategy: 'fixed_schedule', replenishQuantity: 2 });
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async inventory() { return { payload: { available: 10, estimated_total_fen: 200 } }; },
      async balance() { return { payload: { available_fen: 10000 } }; },
    },
  });
  const scheduledFor = '2026-08-16T12:00:00.000Z';

  const first = await service.createOrderForRule(rule, { scheduledFor });
  await repository.updateOrder(first.id, { status: 'completed' });
  const replay = await service.createOrderForRule(rule, { scheduledFor });

  assert.equal(replay.status, 'already_processed');
  assert.equal((await repository.listOrders()).length, 1);
});

test('recovery saves claimed credentials before retrying Sub2API and verifies the same account', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.saveRule({
    ...(await repository.getRule(1)),
    modelWhitelist: ['gpt-5.6', 'gpt-5.2'],
  });
  const tracked = await trackedItem(repository, rule, 6, 106);
  let claimCalls = 0;
  let applyFails = true;
  const gateway = {
    async applyOAuthCredentials(id, credentials, modelWhitelist) {
      assert.equal(id, 106);
      assert.equal(credentials.access_token, 'repaired-token');
      assert.deepEqual(modelWhitelist, ['gpt-5.6', 'gpt-5.2']);
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

test('recovery imports credentials from a claimed replacement file payload', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 70, 170);
  let applied = null;
  const service = new ReplenishmentService(repository, authStub(), {
    async applyOAuthCredentials(id, credentials) {
      applied = { id, credentials };
    },
    async testAccount() {
      return { success: true };
    },
  }, config, console, {
    client: {
      async claimRecovery() {
        return { payload: { payload: { accounts: [{
          email: tracked.externalAccountKey,
          credential_version: 'v3',
          credentials: { access_token: 'replacement-file-token' },
        }] } } };
      },
    },
  });
  const job = await repository.upsertRecovery({
    recoveryKey: `item:${tracked.id}:credential:v1`,
    orderItemId: tracked.id,
    ruleId: rule.id,
    sub2apiAccountId: 170,
    accountKey: tracked.externalAccountKey,
    status: 'claimable',
    claimUrlCiphertext: service.vault.encrypt({ claimUrl: '/api/customer/recoveries/70/claim?ticket=fresh' }),
  });

  await service.claimRecovery(job.id);

  assert.equal(applied.id, 170);
  assert.deepEqual(applied.credentials, {
    access_token: 'replacement-file-token',
    email: tracked.externalAccountKey,
  });
  assert.equal((await repository.getRecovery(job.id)).credentialVersion, 'v3');
});

test('recovery sync finds replacement files on the original order and exposes both order ids', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 71, 171);
  await repository.updateOrder(tracked.orderId, { externalOrderId: '60881', status: 'import_retry' });
  await repository.updateOrderItem(tracked.id, { verificationStatus: 'failed', status: 'waiting_supplier_recovery' });
  await repository.upsertRecovery({
    recoveryKey: `item:${tracked.id}:credential:v1`,
    orderItemId: tracked.id,
    ruleId: rule.id,
    sub2apiAccountId: 171,
    accountKey: tracked.externalAccountKey,
    status: 'waiting_supplier',
  });
  let statusCalls = 0;
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async recoveries() {
        return { payload: { items: [] } };
      },
      async getOrder({ orderId }) {
        assert.equal(orderId, '60881');
        return { payload: { replacement_files: [{
          email: tracked.externalAccountKey,
          status_url: '/api/customer/recoveries/71',
          status: 'processing',
        }] } };
      },
      async getRecoveryStatus() {
        statusCalls += 1;
        return { payload: {
          delivery_status: 'claimable',
          claim_url: '/api/customer/recoveries/71/claim?ticket=fresh',
          credential_version: 'v2',
        } };
      },
    },
  });

  const result = await service.recoveries();
  const saved = result.items.find((entry) => entry.kind === 'account');

  assert.equal(statusCalls, 1);
  assert.equal(saved.status, 'claimable');
  assert.equal(saved.orderId, tracked.orderId);
  assert.equal(saved.externalOrderId, '60881');
  assert.equal(saved.credentialVersion, 'v2');
  assert.ok((await repository.getRecovery(saved.id)).claimUrlCiphertext);
});

test('a consumed recovery link is cleared and an already claimed replacement requires manual confirmation', async () => {
  const repository = new ReplenishmentRepository(null, config);
  const rule = await repository.getRule(1);
  const tracked = await trackedItem(repository, rule, 72, 172);
  await repository.updateOrder(tracked.orderId, { externalOrderId: '60882', status: 'import_retry' });
  await repository.updateOrderItem(tracked.id, { verificationStatus: 'failed', status: 'waiting_supplier_recovery' });
  const service = new ReplenishmentService(repository, authStub(), {}, config, console, {
    client: {
      async claimRecovery() {
        throw Object.assign(new Error('claim already consumed'), { code: 'claim_conflict', httpStatus: 409 });
      },
      async recoveries() {
        return { payload: { items: [] } };
      },
      async getOrder() {
        return { payload: { replacement_files: [{
          email: tracked.externalAccountKey,
          delivery_status: 'claimed',
        }] } };
      },
    },
  });
  const job = await repository.upsertRecovery({
    recoveryKey: `item:${tracked.id}:credential:v1`,
    orderItemId: tracked.id,
    ruleId: rule.id,
    sub2apiAccountId: 172,
    accountKey: tracked.externalAccountKey,
    status: 'claimable',
    claimUrlCiphertext: service.vault.encrypt({ claimUrl: '/api/customer/recoveries/72/claim?ticket=old' }),
  });

  await assert.rejects(service.claimRecovery(job.id), /人工导入/);
  const saved = await repository.getRecovery(job.id);
  assert.equal(saved.status, 'manual_required');
  assert.equal(saved.claimUrlCiphertext, '');
  assert.equal(saved.attemptCount, 0);
  assert.match(saved.lastError, /已被领取/);
});
