import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoRepository } from '../src/repositories/demo-repository.mjs';

const config = { baseCurrency: 'CNY', billingUnit: 'CNY', timezone: 'Asia/Shanghai' };

test('demo writes remain visible for the process lifetime', async () => {
  const repository = new DemoRepository(config);
  const profile = await repository.createCostProfile({ name: '新模板', costType: 'subscription', currency: 'CNY', allocationMethod: 'standard_cost_weight' });
  assert.equal((await repository.listCostProfiles())[0].id, profile.id);

  await repository.createAccountCostPeriod({
    accountId: 2745, costProfileId: profile.id, originalAmount: '20', baseAmount: '20', feeAmount: '1', taxAmount: '0',
    supplier: '测试供应商', purchaseBatch: 'B-001', tags: ['主力', '低成本'],
  });
  const account = (await repository.listAccounts({ search: '测试供应商' })).items[0];
  assert.equal(account.costType, 'subscription');
  assert.deepEqual(account.tags, ['主力', '低成本']);
});

test('manual cash transactions are searchable and update the funds summary', async () => {
  const repository = new DemoRepository(config);
  const before = await repository.listCashTransactions();
  await repository.createCashTransaction({
    transactionType: 'other_expense', direction: 'out', originalAmount: '12.5', originalCurrency: 'CNY',
    baseAmount: '12.5', paymentMethod: 'bank', reference: 'MANUAL-001', party: '机房', occurredAt: new Date().toISOString(),
  });
  const after = await repository.listCashTransactions({ search: '机房' });
  assert.equal(after.items[0].reference, 'MANUAL-001');
  assert.equal(after.summary.transactions, before.summary.transactions + 1);
  assert.equal(after.summary.outflow, before.summary.outflow + 12.5);
});

test('recharge-scoped cash totals exclude operational cash entries but retain refunds', async () => {
  const repository = new DemoRepository(config);
  repository.cashTransactions.push({
    id: 99, reference: 'REFUND-001', type: 'refund', direction: 'out', amount: 1.25, currency: 'CNY',
    method: 'Alipay', party: 'customer@example.com', status: 'confirmed', occurredAt: new Date().toISOString(),
    baseAmountCny: 1.25, creditedAmount: 0, creditedAmountCny: 0, creditedCurrency: 'CNY',
  });
  repository.cashTransactions.push({
    id: 100, reference: 'SUBSCRIPTION-REFUND-001', type: 'refund', orderType: 'subscription', direction: 'out', amount: 9, currency: 'CNY',
    method: 'Alipay', party: 'subscriber@example.com', status: 'confirmed', occurredAt: new Date().toISOString(),
    baseAmountCny: 9, creditedAmount: 0, creditedAmountCny: 0, creditedCurrency: 'CNY',
  });
  const rechargeOnly = await repository.listCashTransactions({ scope: 'recharge', pageSize: 20 });
  assert.ok(rechargeOnly.items.every((item) => item.type === 'recharge' || item.orderType !== 'subscription'));
  assert.equal(rechargeOnly.summary.rechargeReceived, 4);
  assert.equal(rechargeOnly.summary.refunds, 1.25);
  assert.equal(rechargeOnly.summary.net, 2.75);
  assert.equal(rechargeOnly.summary.transactions, 3);
});

test('overview dashboard returns rankings without duplicate consumption aggregates', async () => {
  const repository = new DemoRepository(config);
  const dashboard = await repository.getOverviewDashboard();
  assert.ok(dashboard.totals.balanceCny > 0);
  assert.ok(dashboard.totals.giftBalanceCreditCny > 0);
  assert.equal(dashboard.rankings.tokenUsage[0].email, 'nuohuisong@gmail.com');
  assert.ok(dashboard.rankings.tokenUsage[0].tokens > 0);
  assert.ok(dashboard.rankings.requestActivity[0].requests > 0);
  assert.ok(dashboard.rankings.cashRecharge[0].cashPaidCny > 0);
  assert.equal('userConsumption' in dashboard.rankings, false);
  assert.equal('modelConsumption' in dashboard.rankings, false);
});

test('demo usage summaries support consumption sorting and user-only consumption filters', async () => {
  const repository = new DemoRepository(config);
  const descending = await repository.getUsageBreakdown({ page: 1, pageSize: 100, sort: 'userChargeCny', direction: 'desc' });
  const ascending = await repository.getUsageBreakdown({ page: 1, pageSize: 100, sort: 'userChargeCny', direction: 'asc' });
  const users = await repository.listUsers({ page: 1, pageSize: 100, consumptionOnly: true });

  assert.ok(descending.items[0].userChargeCny >= descending.items.at(-1).userChargeCny);
  assert.ok(ascending.items[0].userChargeCny <= ascending.items.at(-1).userChargeCny);
  assert.ok(descending.items.every((item) => item.grossMargin !== undefined));
  assert.ok(users.items.every((item) => item.userChargeCny > 0));
});

test('demo usage event details support global search and request-level cost fields', async () => {
  const repository = new DemoRepository(config);
  const firstPage = await repository.listUsageEvents({ page: 1, pageSize: 10 });
  const first = firstPage.items[0];
  const searched = await repository.listUsageEvents({ search: first.requestId, page: 1, pageSize: 10 });

  assert.equal(firstPage.total, 48);
  assert.equal(firstPage.items.length, 10);
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].sourceUsageId, first.sourceUsageId);
  assert.ok(searched.items[0].model);
  assert.ok('costStatus' in searched.items[0]);
  assert.ok('calculatedCostCny' in searched.items[0]);
});

test('self-use balance whitelist excludes only reported balances, not usage rankings', async () => {
  const repository = new DemoRepository(config);
  const selfUseAccount = repository.users[0];
  repository.users[1].balanceCny = -9;
  const expectedBalance = repository.users
    .filter((item) => Number(item.balanceCny || 0) > 0 && !item.excludeFromBalanceStats && item !== selfUseAccount)
    .reduce((total, item) => total + Number(item.balanceCny || 0), 0);
  selfUseAccount.excludeFromBalanceStats = true;

  const allUsers = await repository.listUsers({ pageSize: 100, balanceScope: 'all' });
  const reportedBalanceUsers = await repository.listUsers({ pageSize: 100, balanceScope: 'reported' });
  const whitelistedUsers = await repository.listUsers({ pageSize: 100, balanceScope: 'whitelist' });
  const dashboard = await repository.getOverviewDashboard();

  assert.ok(allUsers.items.some((item) => item.id === selfUseAccount.id));
  assert.ok(!reportedBalanceUsers.items.some((item) => item.id === selfUseAccount.id));
  assert.deepEqual(whitelistedUsers.items.map((item) => item.id), [selfUseAccount.id]);
  assert.equal(dashboard.totals.balanceCny, expectedBalance);
  assert.ok(dashboard.rankings.tokenUsage.some((item) => item.id === selfUseAccount.id));
});

test('self-use balance whitelist excludes gift credits from overview and details', async () => {
  const repository = new DemoRepository(config);
  const selfUseAccount = repository.users[0];
  const regularAccount = repository.users[1];
  repository.nonCashBalanceCredits.push({
    id: 2, sourceTable: 'redeem_codes', sourceId: 'DEMO-002', type: 'redeem', amountCny: 3,
    occurredAt: new Date().toISOString(), action: 'used', redeemType: 'balance',
    sourceUserId: regularAccount.id, email: regularAccount.email, username: regularAccount.username,
  });
  selfUseAccount.excludeFromBalanceStats = true;

  const dashboard = await repository.getOverviewDashboard();
  const credits = await repository.listNonCashBalanceCredits({ page: 1, pageSize: 20 });

  assert.equal(dashboard.totals.giftBalanceCreditCny, 3);
  assert.equal(dashboard.totals.giftBalanceCreditCount, 1);
  assert.deepEqual(credits.summary, { amountCny: 3, events: 1 });
  assert.deepEqual(credits.items.map((item) => item.sourceId), ['DEMO-002']);
  assert.ok(dashboard.rankings.tokenUsage.some((item) => item.id === selfUseAccount.id));
});

test('supplier overview groups account economics and exposes purchase rows', async () => {
  const repository = new DemoRepository(config);
  const overview = await repository.getSupplierOverview({ search: 'Cloud Seats' });
  assert.equal(overview.items.length, 1);
  assert.equal(overview.items[0].supplier, 'Cloud Seats');
  assert.equal(overview.items[0].accountCount, 2);
  assert.ok(overview.items[0].purchaseSpend > 0);
  assert.equal(overview.purchases.length, 2);
  assert.equal(overview.summary.supplierCount, 1);
});

test('purchase catalog returns FinOps suppliers and supplier-scoped batches', async () => {
  const repository = new DemoRepository(config);
  const catalog = await repository.listPurchaseCatalog();
  assert.ok(catalog.suppliers.includes('Cloud Seats'));
  assert.ok(catalog.batches.some((item) => (
    item.supplier === 'Cloud Seats' && item.purchaseBatch === '2026-07-B1'
  )));

  await repository.createAccountCostPeriod({
    accountId: 2745, originalAmount: '20', baseAmount: '20', feeAmount: '0', taxAmount: '0',
    supplier: '新供应商', purchaseBatch: 'NEW-BATCH',
    effectiveFrom: '2026-08-01T00:00:00+08:00', effectiveTo: '2026-09-01T00:00:00+08:00',
  });
  const refreshed = await repository.listPurchaseCatalog();
  assert.ok(refreshed.suppliers.includes('新供应商'));
  assert.ok(refreshed.batches.some((item) => (
    item.supplier === '新供应商' && item.purchaseBatch === 'NEW-BATCH'
  )));
});

test('demo supplier connections support create, edit, sync, account links, and alert acknowledgement', async () => {
  const repository = new DemoRepository(config);
  const input = {
    supplierName: 'Demo Provider', name: 'main portal', adapterType: 'sub2api', baseUrl: 'https://supplier.example.test',
    authMode: 'password', credentialLabel: 'operator@example.test', enabled: true,
    inventoryIntervalMinutes: 15, activeCheckEnabled: true, activeCheckLimit: 10,
    lowBalanceThreshold: null, balanceCurrency: 'USD',
    credentials: {
      username: 'operator', password: 'secret', accessToken: '', apiKey: '', totpSecret: '',
      keyName: '', rateMultiplier: null, balance: null, balanceCurrency: '',
    },
  };

  const created = await repository.createSupplierConnection(input, 'demo-encrypted');
  assert.equal(created.credentialsCiphertext, undefined);
  assert.equal(created.connectionStatus, 'pending');

  const sync = await repository.syncSupplierConnection(created.id);
  assert.equal(sync.ok, true);
  const details = await repository.getSupplierConnectionDetails(created.id);
  assert.equal(details.connection.connectionStatus, 'ok');
  assert.equal(details.keys.length, 1);
  assert.equal(details.checks.length, 1);

  const key = details.keys[0];
  await repository.setSupplierKeyAccountLink(key.id, 2742, true);
  const linked = await repository.getSupplierConnectionDetails(created.id);
  assert.deepEqual(linked.keys[0].accountLinks, [{ accountId: 2742, accountName: 'PaulaAcacia8221+see2@outlook.com' }]);

  const updated = await repository.updateSupplierConnection(created.id, {
    ...input,
    name: 'updated portal',
    authMode: 'access_token',
    credentials: { ...input.credentials, username: '', password: '', accessToken: 'token' },
  }, 'demo-updated');
  assert.equal(updated.name, 'updated portal');
  assert.equal(updated.authMode, 'access_token');
  assert.equal((await repository.getSupplierConnection(created.id, { includeCiphertext: true })).credentialsCiphertext, 'demo-updated');

  const initial = await repository.getSupplierConnectionDetails(1);
  const acknowledged = await repository.acknowledgeSupplierAlert(initial.alerts[0].id, 'demo-admin');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal((await repository.getSupplierConnectionDetails(1)).connection.openAlertCount, 0);
});

test('sync details expose source-level health without errors', async () => {
  const repository = new DemoRepository(config);
  const details = await repository.getSyncDetails();
  assert.equal(details.status, 'healthy');
  assert.equal(details.errorCount, 0);
  assert.ok(details.sources.some((item) => item.sourceName === 'usage_logs'));
  assert.ok(details.rowsSynced > 0);
});

test('demo accounting is CNY-only and rejects cost periods on free accounts', async () => {
  const repository = new DemoRepository(config);
  const bootstrap = await repository.getBootstrap();
  assert.equal(bootstrap.billingUnit, 'CNY');
  assert.equal(bootstrap.balanceCurrency, 'CNY');
  assert.equal(bootstrap.referenceCurrency, 'USD');

  const profile = await repository.createCostProfile({
    name: '免费资源', costType: 'free', currency: 'CNY', allocationMethod: 'none',
  });
  await assert.rejects(repository.createAccountCostPeriod({
    accountId: 2745, costProfileId: profile.id, originalAmount: '1', baseAmount: '1',
  }), /free accounts cannot have a CNY cost period/);
});

test('demo account cost history is paginated and editable by period', async () => {
  const repository = new DemoRepository(config);
  const first = await repository.listAccountCostPeriods({ accountId: 2745, page: 1, pageSize: 1 });
  assert.equal(first.total, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].accountId, 2745);
  await repository.updateAccountCostPeriod(first.items[0].id, {
    originalAmount: '41', baseAmount: '41', feeAmount: '0', taxAmount: '0',
    effectiveFrom: first.items[0].effectiveFrom, effectiveTo: first.items[0].effectiveTo,
    supplier: 'new supplier', purchaseBatch: 'NEW-BATCH', notes: 'revised',
    correctionReason: '采购单金额录入错误',
  });
  const updated = (await repository.listAccountCostPeriods({ accountId: 2745 })).items[0];
  assert.equal(updated.originalAmount, '41');
  assert.equal(updated.supplier, 'new supplier');
});

test('public group monitor contains only enabled configured groups', async () => {
  const repository = new DemoRepository(config);
  const candidates = await repository.listMonitorGroupCandidates();
  assert.equal(candidates[0].name, 'GPT PLUS【限时特惠】');
  assert.equal(candidates[0].groupMultiplier, 0.08);
  const before = await repository.getPublicMonitorDashboard();
  assert.ok(before.groups.length >= 1);
  assert.equal(before.groups[0].history.length, 60);
  assert.equal('availableAccountCount' in before.groups[0], false);
  assert.equal('totalAccountCount' in before.groups[0], false);
  assert.equal('availableAccountCount' in before.groups[0].history[0], false);
  assert.equal('totalAccountCount' in before.groups[0].history[0], false);

  await repository.updateMonitorGroup(before.groups[0].id, {
    name: before.groups[0].name,
    sourceGroupId: before.groups[0].sourceGroupId,
    modelLabel: before.groups[0].modelLabel,
    displayOrder: before.groups[0].displayOrder,
    enabled: false,
  });
  const after = await repository.getPublicMonitorDashboard();
  assert.equal(after.groups.some((group) => group.id === before.groups[0].id), false);
});
