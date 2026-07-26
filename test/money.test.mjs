import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateFixedCost, grossMargin } from '../src/domain/money.mjs';

test('fixed cost allocation preserves the exact total', () => {
  const result = allocateFixedCost('100', ['1', '2', '3']);
  assert.equal(result.allocations.reduce((sum, value) => sum.plus(value)).toString(), '100');
  assert.equal(result.idleCost.toString(), '0');
});

test('zero usage keeps the full fixed cost as idle cost', () => {
  const result = allocateFixedCost('88.5', ['0', '0']);
  assert.deepEqual(result.allocations.map(String), ['0', '0']);
  assert.equal(result.idleCost.toString(), '88.5');
});

test('gross margin is undefined when revenue is zero', () => {
  assert.equal(grossMargin(0, 1), null);
  assert.equal(grossMargin(100, 25).toString(), '0.75');
});
