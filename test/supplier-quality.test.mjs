import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilityScore, supplierQualityScore, ttftScore } from '../src/services/supplier-quality.mjs';

test('TTFT scoring rewards fast first tokens and penalizes slow tails', () => {
  assert.equal(ttftScore(500, 700), 100);
  assert.ok(ttftScore(2_000, 2_500) > ttftScore(8_000, 24_000));
  assert.equal(ttftScore(null), null);
});

test('supplier quality scoring rebalances missing dimensions', () => {
  const result = supplierQualityScore({
    sampleCount: 20,
    availabilitySamples: 20,
    successSamples: 19,
    failureCount: 1,
    ttftP50Ms: 1_000,
    ttftP95Ms: 1_500,
    rateMultiplier: null,
  });
  assert.equal(result.priceScore, null);
  assert.ok(result.overallScore > 90);
  assert.ok(result.confidence > 60);
});

test('quality confidence remains low with sparse samples', () => {
  const result = supplierQualityScore({
    sampleCount: 1,
    availabilitySamples: 1,
    successSamples: 1,
    failureCount: 0,
    ttftP50Ms: 900,
    ttftP95Ms: 900,
    rateMultiplier: 1,
  }, { bestRateMultiplier: 1 });
  assert.ok(result.confidence < 50);
  assert.equal(stabilityScore({
    sampleCount: 1, failureCount: 1, ttftP50Ms: null, ttftP95Ms: null,
  }), 30);
});
