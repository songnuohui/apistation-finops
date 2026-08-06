import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { authorize, sessionCookie } from '../src/auth.mjs';
import { accountScope, cashScope, pagination, resolveRange, userBalanceScope } from '../src/http/query.mjs';
import { resolveStaticPath } from '../src/http/static-path.mjs';
import {
  normalizeAccountCostArchive, normalizeAccountCostPeriod, normalizeAccountCostPeriodUpdate, normalizeAccountCostReprice, normalizeBulkAccountCostPeriods,
  normalizeAccountLedger, normalizeCashTransaction, normalizeCostProfile, normalizeMonitorGroup,
  normalizeMonitorSettings, assertSupplierCredentials, normalizeSupplierConnection, normalizeSupplierQualityTarget,
  mergeSupplierCredentials,
  normalizeAlertNotificationSettings,
  normalizeAccountProfitGuard,
  normalizeSub2ApiServiceAuthSettings,
} from '../src/http/validation.mjs';

test('today and month ranges start at midnight in the configured timezone', () => {
  const now = new Date('2026-07-25T16:30:00.000Z');
  const today = resolveRange(new URLSearchParams('range=today'), now, 'Asia/Shanghai');
  const month = resolveRange(new URLSearchParams('range=month'), now, 'Asia/Shanghai');
  assert.equal(today.start.toISOString(), '2026-07-25T16:00:00.000Z');
  assert.equal(month.start.toISOString(), '2026-06-30T16:00:00.000Z');
});

test('seven and thirty day ranges start at local midnight for daily reporting', () => {
  const now = new Date('2026-07-25T16:30:00.000Z');
  const sevenDays = resolveRange(new URLSearchParams('range=7d'), now, 'Asia/Shanghai');
  const thirtyDays = resolveRange(new URLSearchParams('range=30d'), now, 'Asia/Shanghai');
  assert.equal(sevenDays.start.toISOString(), '2026-07-19T16:00:00.000Z');
  assert.equal(thirtyDays.start.toISOString(), '2026-06-26T16:00:00.000Z');
});

test('custom ranges use inclusive local calendar dates', () => {
  const range = resolveRange(new URLSearchParams('range=custom&start=2026-07-01&end=2026-07-31'), new Date(), 'Asia/Shanghai');
  assert.equal(range.start.toISOString(), '2026-06-30T16:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-07-31T16:00:00.000Z');
  assert.throws(() => resolveRange(new URLSearchParams('range=custom&start=2026-07-31&end=2026-07-30')), /invalid custom date range/);
});

test('pagination validates numeric input and caps page size', () => {
  assert.deepEqual(pagination(new URLSearchParams('page=2&page_size=500')), { page: 2, pageSize: 100, offset: 100 });
  assert.throws(() => pagination(new URLSearchParams('page=1x')), /invalid page/);
});

test('account scope defaults to current accounts and rejects invalid values', () => {
  assert.equal(accountScope(new URLSearchParams()), 'current');
  assert.equal(accountScope(new URLSearchParams('scope=deleted')), 'deleted');
  assert.equal(accountScope(new URLSearchParams('scope=all')), 'all');
  assert.throws(() => accountScope(new URLSearchParams('scope=unexpected')), /invalid account scope/);
});

test('cash and reported-balance scopes accept only their supported values', () => {
  assert.equal(cashScope(new URLSearchParams()), 'all');
  assert.equal(cashScope(new URLSearchParams('scope=recharge')), 'recharge');
  assert.throws(() => cashScope(new URLSearchParams('scope=refund')), /invalid cash scope/);

  assert.equal(userBalanceScope(new URLSearchParams()), 'all');
  assert.equal(userBalanceScope(new URLSearchParams('balance_scope=reported')), 'reported');
  assert.equal(userBalanceScope(new URLSearchParams('balance_scope=whitelist')), 'whitelist');
  assert.throws(() => userBalanceScope(new URLSearchParams('balance_scope=whitelisted')), /invalid user balance scope/);
});

test('authorization accepts a valid signed administrator session only', () => {
  const config = {
    authDisabled: false,
    sessionSecret: '12345678901234567890123456789012',
    sessionTtlSeconds: 3600,
    sessionCookieSecure: true,
  };
  const now = Date.parse('2026-07-31T08:00:00.000Z');
  const cookie = sessionCookie({ id: 7, username: 'Finance Admin', email: 'admin@example.com' }, config, now);
  const request = { headers: { cookie: cookie.split(';')[0] } };
  assert.equal(authorize(request, config, now).ok, true);
  assert.equal(authorize({ headers: { cookie: `${cookie.split(';')[0]}tampered` } }, config, now).ok, false);
  assert.equal(authorize(request, config, now + 3_601_000).ok, false);
});

test('static path resolution rejects traversal outside the web root', () => {
  const webRoot = path.resolve('web');
  assert.equal(resolveStaticPath(webRoot, '/accounts'), path.join(webRoot, 'index.html'));
  assert.throws(() => resolveStaticPath(webRoot, '/../web-evil/secret.css'), /forbidden/);
});

test('write payloads are normalized and invalid financial data is rejected', () => {
  assert.equal(normalizeCostProfile({ name: '月租', costType: 'subscription', currency: 'cny', allocationMethod: 'standard_cost_weight' }).currency, 'CNY');
  assert.throws(() => normalizeCostProfile({
    name: 'free mismatch', costType: 'free', costMode: 'fixed_purchase', currency: 'CNY', allocationMethod: 'none',
  }), /free costType requires free costMode/);
  const legacyProfile = normalizeCostProfile({
    name: 'legacy multiplier', costType: 'metered', currency: 'CNY', allocationMethod: 'token_weight',
    defaultSellingMultiplier: '8',
  });
  assert.equal('defaultSellingMultiplier' in legacyProfile, false);
  const legacyLedger = normalizeAccountLedger({ costMode: 'manual_multiplier', sellingMultiplier: '8' });
  assert.equal(legacyLedger.upstreamMultiplier, null);
  assert.equal('sellingMultiplier' in legacyLedger, false);
  const manualLedger = normalizeAccountLedger({
    costMode: 'manual_multiplier', upstreamMultiplier: '0.07', basisMode: 'revenue_backsolve',
  });
  assert.equal(manualLedger.upstreamMultiplier, '0.07');
  assert.equal(manualLedger.basisMode, 'revenue_backsolve');
  assert.equal(normalizeAccountLedger({ costMode: 'manual_multiplier', changeStrategy: 'current_day' }).changeStrategy, 'current_day');
  assert.throws(() => normalizeAccountLedger({ changeStrategy: 'rewrite_everything' }), /invalid changeStrategy/);
  assert.equal(normalizeAccountCostArchive({ cutoffAt: '2026-08-01T12:00:00+08:00', notes: '日结' }).notes, '日结');
  const reprice = normalizeAccountCostReprice({
    effectiveFrom: '2026-07-01T00:00:00+08:00', effectiveTo: '2026-08-01T00:00:00+08:00',
    costMode: 'manual_multiplier', basisMode: 'revenue_backsolve',
    upstreamMultiplier: '0.05', notes: '修正手工录入',
  });
  assert.equal(reprice.upstreamMultiplier, '0.05');
  assert.equal('sellingMultiplier' in reprice, false);
  assert.throws(() => normalizeAccountCostReprice({
    ...reprice, effectiveFrom: reprice.effectiveTo,
  }), /effectiveTo/);
  assert.throws(() => normalizeAccountCostReprice({
    ...reprice, upstreamMultiplier: '',
  }), /upstreamMultiplier/);
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
  assert.equal(normalizeAccountCostPeriodUpdate({ ...period }).accountId, undefined);
  assert.equal(normalizeAccountCostPeriodUpdate({
    ...period, correctionReason: '采购单录入金额有误',
  }).correctionReason, '采购单录入金额有误');
  assert.deepEqual(normalizeBulkAccountCostPeriods({ ...period, accountIds: [2745, '2745', 2742] }).accountIds, [2745, 2742]);
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

test('monitor group configuration validates a positive source group ID and display settings', () => {
  assert.deepEqual(normalizeMonitorGroup({
    name: 'GPT PLUS', sourceGroupId: '12', modelLabel: 'gpt-5.4', displayOrder: '4', enabled: 'false',
  }), {
    name: 'GPT PLUS', sourceGroupId: 12, modelLabel: 'gpt-5.4', displayOrder: 4, enabled: false,
  });
  assert.throws(() => normalizeMonitorGroup({ name: 'invalid', sourceGroupId: '0' }), /invalid sourceGroupId/);
  assert.throws(() => normalizeMonitorGroup({ name: 'invalid', sourceGroupId: 'abc' }), /invalid sourceGroupId/);
});

test('monitor settings validate a bounded refresh interval', () => {
  assert.deepEqual(normalizeMonitorSettings({ refreshIntervalSeconds: '45' }), { refreshIntervalSeconds: 45 });
  assert.throws(() => normalizeMonitorSettings({ refreshIntervalSeconds: '4' }), /invalid refreshIntervalSeconds/);
  assert.throws(() => normalizeMonitorSettings({ refreshIntervalSeconds: '3601' }), /invalid refreshIntervalSeconds/);
});

test('supplier connections validate encrypted portal and API-key credentials', () => {
  const connection = normalizeSupplierConnection({
    supplierName: 'Upstream', name: 'main account', adapterType: 'sub2api',
    baseUrl: 'https://supplier.example.test', credentials: { username: 'operator', password: 'secret', totpSecret: 'ABC' },
  });
  assert.equal(connection.authMode, 'password');
  assert.deepEqual(Object.keys(connection.credentials).sort(), [
    'accessToken', 'apiKey', 'balance', 'balanceCurrency', 'keyName', 'password', 'rateMultiplier', 'totpSecret', 'username',
  ]);
  assert.equal(assertSupplierCredentials(connection), true);
  const missingPassword = normalizeSupplierConnection({
    supplierName: 'Upstream', name: 'missing password', adapterType: 'newapi',
    baseUrl: 'https://supplier.example.test', credentials: { username: 'operator' },
  });
  assert.throws(() => assertSupplierCredentials(missingPassword), /password authentication requires username and password/);
  const tokenConnection = normalizeSupplierConnection({
    supplierName: 'Upstream', name: 'token account', adapterType: 'newapi', authMode: 'access_token',
    baseUrl: 'https://supplier.example.test', credentials: { accessToken: 'portal-token' },
  });
  assert.equal(assertSupplierCredentials(tokenConnection), true);
  const openAi = normalizeSupplierConnection({
    supplierName: 'OpenAI compatible', name: 'key', adapterType: 'openai_compatible',
    baseUrl: 'https://supplier.example.test', credentials: { apiKey: 'sk-secret' },
  });
  assert.equal(openAi.authMode, 'api_key');
  assert.equal(assertSupplierCredentials(openAi), true);
  assert.throws(() => assertSupplierCredentials({ ...openAi, authMode: 'access_token' }), /requires api_key/);
});

test('editing supplier credentials can keep or partially replace the encrypted credentials', () => {
  const existing = {
    username: 'operator@example.test',
    password: 'old-secret',
    totpSecret: 'OLD-TOTP',
    accessToken: 'stale-token',
    sessionCookie: 'stale-cookie',
    userId: '9',
  };
  assert.deepEqual(mergeSupplierCredentials(existing, {}), existing);
  assert.deepEqual(mergeSupplierCredentials(existing, { password: 'new-secret' }), {
    username: 'operator@example.test',
    password: 'new-secret',
    totpSecret: 'OLD-TOTP',
    accessToken: '',
    sessionCookie: '',
    userId: '',
    accessTokenExpiresAt: null,
  });
});

test('supplier quality targets require a selected model and bounded probe costs', () => {
  assert.deepEqual(normalizeSupplierQualityTarget({
    keyId: '9', model: 'gpt-4o-mini', intervalSeconds: '900', maxOutputTokens: '2', enabled: 'true',
  }), {
    keyId: 9, model: 'gpt-4o-mini', intervalSeconds: 900, maxOutputTokens: 2, enabled: true,
  });
  assert.throws(() => normalizeSupplierQualityTarget({ keyId: 9, model: '', intervalSeconds: 900 }), /missing field: model/);
  assert.throws(() => normalizeSupplierQualityTarget({ keyId: 9, model: 'gpt-4o-mini', intervalSeconds: 59 }), /invalid intervalSeconds/);
  assert.throws(() => normalizeSupplierQualityTarget({ keyId: 9, model: 'gpt-4o-mini', maxOutputTokens: 33 }), /invalid maxOutputTokens/);
});

test('QQ alert settings require a numeric recipient and a safe HTTP OneBot endpoint', () => {
  assert.deepEqual(normalizeAlertNotificationSettings({
    enabled: 'true',
    qqNumber: '123456789',
    onebotEndpoint: 'http://127.0.0.1:3000',
    accessToken: 'secret',
  }), {
    enabled: true,
    qqNumber: '123456789',
    onebotEndpoint: 'http://127.0.0.1:3000',
    accessToken: 'secret',
    clearAccessToken: false,
  });
  assert.throws(() => normalizeAlertNotificationSettings({
    enabled: true, qqNumber: 'not-qq', onebotEndpoint: 'http://127.0.0.1:3000',
  }), /qqNumber/);
  assert.throws(() => normalizeAlertNotificationSettings({
    enabled: true, qqNumber: '123456789', onebotEndpoint: 'ftp://127.0.0.1',
  }), /onebotEndpoint/);
  assert.throws(() => normalizeAlertNotificationSettings({
    enabled: true, qqNumber: '', onebotEndpoint: '',
  }), /require qqNumber and onebotEndpoint/);
});

test('Sub2API service authentication validates credentials without exposing a token field', () => {
  assert.deepEqual(normalizeSub2ApiServiceAuthSettings({
    enabled: 'true',
    email: 'finops-service@example.com',
    password: 'service-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
  }), {
    enabled: true,
    authMode: 'password',
    email: 'finops-service@example.com',
    password: 'service-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    apiKey: '',
    clearCredentials: false,
  });
  assert.deepEqual(normalizeSub2ApiServiceAuthSettings({
    enabled: true, authMode: 'api_key', apiKey: 'admin-6e01-example',
  }), {
    enabled: true,
    authMode: 'api_key',
    email: '',
    password: '',
    totpSecret: '',
    apiKey: 'admin-6e01-example',
    clearCredentials: false,
  });
  assert.throws(
    () => normalizeSub2ApiServiceAuthSettings({ enabled: 'not-a-boolean' }),
    /invalid enabled/,
  );
});

test('profit guard settings use a fractional margin and reject unsafe thresholds', () => {
  assert.deepEqual(normalizeAccountProfitGuard({
    enabled: true, minimumMargin: '0.2', allowEmptyGroups: true,
  }), {
    enabled: true, minimumMargin: 0.2, thresholdMode: 'margin',
    minimumSaleMultiplier: null, allowEmptyGroups: true,
  });
  assert.deepEqual(normalizeAccountProfitGuard({ enabled: true }), {
    enabled: true, minimumMargin: 0, thresholdMode: 'margin',
    minimumSaleMultiplier: null, allowEmptyGroups: true,
  });
  assert.deepEqual(normalizeAccountProfitGuard({
    enabled: true, thresholdMode: 'minimum_sale_multiplier', minimumSaleMultiplier: '0.125',
  }), {
    enabled: true, minimumMargin: 0, thresholdMode: 'minimum_sale_multiplier',
    minimumSaleMultiplier: 0.125, allowEmptyGroups: true,
  });
  assert.throws(() => normalizeAccountProfitGuard({
    thresholdMode: 'minimum_sale_multiplier',
  }), /minimumSaleMultiplier/);
  assert.throws(() => normalizeAccountProfitGuard({ minimumMargin: '1' }), /between 0 and 1/);
});
