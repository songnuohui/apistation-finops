import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMultiplierCostCny,
  effectiveObservedMultiplierAt,
  normalizeUpstreamBillingSnapshot,
  splitFixedCostCny,
} from '../src/services/cost-accounting.mjs';

test('revenue-backsolve uses CNY user charge, selling multiplier, and upstream multiplier', () => {
  const result = calculateMultiplierCostCny({
    mode: 'probe_multiplier',
    basisMode: 'revenue_backsolve',
    userChargeCny: '100',
    sellingMultiplier: '2',
    upstreamMultiplier: '0.8',
  });
  assert.equal(result.status, 'priced');
  assert.equal(result.costCny, '40');
});

test('reference CNY basis never performs implicit USD conversion', () => {
  const result = calculateMultiplierCostCny({
    mode: 'manual_multiplier',
    basisMode: 'reference_cny',
    standardCostReference: '10',
    upstreamMultiplier: '0.5',
    cnyPerReferenceUnit: '7.2',
  });
  assert.equal(result.status, 'priced');
  assert.equal(result.costCny, '36');
});

test('multiplier costs remain unpriced when the CNY basis is missing', () => {
  const result = calculateMultiplierCostCny({
    mode: 'manual_multiplier',
    basisMode: 'reference_cny',
    standardCostReference: '10',
    upstreamMultiplier: '0.5',
  });
  assert.equal(result.status, 'missing_cny_basis');
  assert.equal(result.costCny, null);
});

test('probe snapshot keeps sanitized billing fields and excludes unrelated data', () => {
  const result = normalizeUpstreamBillingSnapshot({
    status: 'ok',
    received_at: '2026-07-31T01:00:00Z',
    fresh_until: '2026-07-31T01:30:00Z',
    data: {
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      resolved_rate_multiplier: 0.8,
      effective_rate_multiplier: 0.9,
      observed_at: '2026-07-31T01:00:00Z',
      credentials: 'must not be copied',
    },
    secret: 'must not be copied',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.effectiveRateMultiplier, '0.9');
  assert.equal(result.data.credentials, undefined);
  assert.equal(result.data.effective_rate_multiplier, '0.9');
  assert.match(result.snapshotKey, /^ok\|/);
});

test('observed multiplier is recalculated for the usage time in the declared timezone', () => {
  const observation = {
    resolvedRateMultiplier: '0.8',
    effectiveRateMultiplier: '0.8',
    peakRateEnabled: true,
    peakStart: '09:00',
    peakEnd: '18:00',
    peakRateMultiplier: '1.5',
    timezone: 'Asia/Shanghai',
  };
  assert.equal(effectiveObservedMultiplierAt(observation, '2026-07-31T02:00:00Z'), '1.2');
  assert.equal(effectiveObservedMultiplierAt(observation, '2026-07-31T12:00:00Z'), '0.8');
});

test('invalid peak metadata falls back to the effective multiplier observed upstream', () => {
  assert.equal(effectiveObservedMultiplierAt({
    resolvedRateMultiplier: '0.8',
    effectiveRateMultiplier: '1.2',
    peakRateEnabled: true,
    peakStart: '22:00',
    peakEnd: '02:00',
    peakRateMultiplier: '1.5',
    timezone: 'Asia/Shanghai',
  }, '2026-07-31T12:00:00Z'), '1.2');
});

test('bulk fixed cost allocation preserves the exact decimal total', () => {
  const allocation = splitFixedCostCny('0.30', [1, 2], 'equal');
  assert.deepEqual(allocation, [
    { accountId: 1, amountCny: '0.15' },
    { accountId: 2, amountCny: '0.15' },
  ]);
});

test('weighted allocation falls back to equal when all weights are zero', () => {
  const allocation = splitFixedCostCny('10', [1, 2], 'token_weight', { 1: 0, 2: 0 });
  assert.deepEqual(allocation.map((item) => item.amountCny), ['5', '5']);
});
