import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { authorize } from '../src/auth.mjs';
import { pagination, resolveRange } from '../src/http/query.mjs';
import { resolveStaticPath } from '../src/http/static-path.mjs';
import { normalizeAccountCostPeriod, normalizeCashTransaction, normalizeCostProfile } from '../src/http/validation.mjs';

test('today and month ranges start at midnight in the configured timezone', () => {
  const now = new Date('2026-07-25T16:30:00.000Z');
  const today = resolveRange(new URLSearchParams('range=today'), now, 'Asia/Shanghai');
  const month = resolveRange(new URLSearchParams('range=month'), now, 'Asia/Shanghai');
  assert.equal(today.start.toISOString(), '2026-07-25T16:00:00.000Z');
  assert.equal(month.start.toISOString(), '2026-06-30T16:00:00.000Z');
});

test('pagination validates numeric input and caps page size', () => {
  assert.deepEqual(pagination(new URLSearchParams('page=2&page_size=500')), { page: 2, pageSize: 100, offset: 100 });
  assert.throws(() => pagination(new URLSearchParams('page=1x')), /invalid page/);
});

test('authorization accepts only the configured bearer token', () => {
  const config = { authDisabled: false, adminToken: '123456789012345678901234' };
  assert.equal(authorize({ headers: { authorization: `Bearer ${config.adminToken}` } }, config).ok, true);
  assert.equal(authorize({ headers: { authorization: 'Bearer wrong' } }, config).ok, false);
});

test('static path resolution rejects traversal outside the web root', () => {
  const webRoot = path.resolve('web');
  assert.equal(resolveStaticPath(webRoot, '/accounts'), path.join(webRoot, 'index.html'));
  assert.throws(() => resolveStaticPath(webRoot, '/../web-evil/secret.css'), /forbidden/);
});

test('write payloads are normalized and invalid financial data is rejected', () => {
  assert.equal(normalizeCostProfile({ name: '月租', costType: 'subscription', currency: 'cny', allocationMethod: 'standard_cost_weight' }).currency, 'CNY');
  const period = normalizeAccountCostPeriod({
    accountId: '2745', originalAmount: '35', originalCurrency: 'CNY', fxRate: '1', baseAmount: '35',
    effectiveFrom: '2026-07-01T00:00:00+08:00', effectiveTo: '2026-08-01T00:00:00+08:00', tags: '主力, GPT PLUS,主力',
  });
  assert.deepEqual(period.tags, ['主力', 'GPT PLUS']);
  assert.throws(() => normalizeAccountCostPeriod({ ...period, effectiveTo: period.effectiveFrom }), /effectiveTo/);
  assert.equal(normalizeCashTransaction({
    transactionType: 'other_expense', originalAmount: '12.50', originalCurrency: 'CNY', fxRate: '1', baseAmount: '12.50', occurredAt: '2026-07-26T10:00:00+08:00',
  }).direction, 'out');
  assert.throws(() => normalizeCashTransaction({
    transactionType: 'supplier_topup', originalAmount: '100', originalCurrency: 'USD', fxRate: '7.2', baseAmount: '720', occurredAt: '2026-07-26T10:00:00+08:00',
  }), /must be CNY|fxRate must be 1/);
  assert.throws(() => normalizeCostProfile({ name: '美元成本', costType: 'metered', currency: 'USD', allocationMethod: 'token_weight' }), /must be CNY/);
  assert.throws(() => normalizeAccountCostPeriod({ ...period, originalCurrency: 'USD' }), /must be CNY/);
  assert.deepEqual(
    { originalAmount: period.originalAmount, originalCurrency: period.originalCurrency, fxRate: period.fxRate, baseAmount: period.baseAmount },
    { originalAmount: '35', originalCurrency: 'CNY', fxRate: '1', baseAmount: '35' },
  );
  assert.throws(() => normalizeAccountCostPeriod({ ...period, fxRate: '7.2' }), /fxRate must be 1/);
  assert.throws(() => normalizeAccountCostPeriod({ ...period, baseAmount: '36' }), /baseAmount must equal originalAmount/);
});

test('CNY cash amounts are server-derived and contradictory values are rejected', () => {
  const cash = normalizeCashTransaction({
    transactionType: 'other_expense', originalAmount: '12.50', occurredAt: '2026-07-26T10:00:00+08:00',
  });
  assert.deepEqual(
    { originalAmount: cash.originalAmount, originalCurrency: cash.originalCurrency, fxRate: cash.fxRate, baseAmount: cash.baseAmount },
    { originalAmount: '12.5', originalCurrency: 'CNY', fxRate: '1', baseAmount: '12.5' },
  );
  assert.throws(() => normalizeCashTransaction({
    transactionType: 'supplier_topup', originalAmount: '100', fxRate: '7.2', occurredAt: '2026-07-26T10:00:00+08:00',
  }), /fxRate must be 1/);
  assert.throws(() => normalizeCashTransaction({
    transactionType: 'supplier_topup', originalAmount: '100', baseAmount: '720', occurredAt: '2026-07-26T10:00:00+08:00',
  }), /baseAmount must equal originalAmount/);
});
