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
