import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupplierQualityScores,
  stabilityScore,
  supplierQualityScore,
  ttftScore,
  wilsonLowerBound,
} from '../src/services/supplier-quality.mjs';

const now = new Date('2026-08-05T10:00:00.000Z');

function observation(connectionId, keyId, model, overrides = {}) {
  return {
    connectionId,
    keyId,
    model,
    sourceKind: 'active_probe',
    status: 'ok',
    availabilitySample: true,
    ttftMs: 900,
    observedAt: new Date(now.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

test('TTFT scoring rewards fast first tokens and penalizes slow tails', () => {
  assert.equal(ttftScore(500, 700), 100);
  assert.ok(ttftScore(2_000, 2_500) > ttftScore(8_000, 24_000));
  assert.equal(ttftScore(null), null);
});

test('Wilson availability avoids perfect scores from sparse samples', () => {
  assert.ok(wilsonLowerBound(2, 2) < 40);
  assert.ok(wilsonLowerBound(100, 100) > 95);
  assert.equal(wilsonLowerBound(0, 0), null);
});

test('supplier quality scoring applies availability gates and confidence risk adjustment', () => {
  const result = supplierQualityScore({
    sampleCount: 20,
    availabilitySamples: 20,
    successSamples: 19,
    failureCount: 1,
    ttftP50Ms: 1_000,
    ttftP95Ms: 1_500,
    rateMultiplier: null,
    lastSuccessAt: now.toISOString(),
  }, { now: now.getTime() });
  assert.equal(result.priceScore, null);
  assert.equal(result.rawOverallScore, 59);
  assert.ok(result.riskAdjustedScore < result.rawOverallScore);
  assert.equal(result.dataStatus, 'unavailable');
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
    lastSuccessAt: now.toISOString(),
  }, { bestRateMultiplier: 1, comparableSupplierCount: 2 });
  assert.ok(result.confidence < 50);
  assert.equal(stabilityScore({
    sampleCount: 1, failureCount: 1, ttftP50Ms: null, ttftP95Ms: null,
  }), 30);
});

test('same-model prices compare across suppliers and singleton models stay unpriced', () => {
  const scores = buildSupplierQualityScores({
    now: now.getTime(),
    connections: [{ id: 1 }, { id: 2 }],
    keys: [
      { id: 11, connectionId: 1, status: 'active', rateMultiplier: 0.05 },
      { id: 22, connectionId: 2, status: 'active', rateMultiplier: 0.1 },
    ],
    targets: [
      { connectionId: 1, keyId: 11, model: 'shared-model', enabled: true },
      { connectionId: 2, keyId: 22, model: 'shared-model', enabled: true },
      { connectionId: 1, keyId: 11, model: 'singleton-model', enabled: true },
    ],
    observations: [
      ...Array.from({ length: 100 }, (_, index) => observation(1, 11, 'shared-model', { observedAt: new Date(now.getTime() - index * 60_000).toISOString() })),
      ...Array.from({ length: 100 }, (_, index) => observation(2, 22, 'shared-model', { observedAt: new Date(now.getTime() - index * 60_000).toISOString() })),
      ...Array.from({ length: 100 }, (_, index) => observation(1, 11, 'singleton-model', { observedAt: new Date(now.getTime() - index * 60_000).toISOString() })),
    ],
  });
  const cheap = scores[0].score.modelScores.find((item) => item.model === 'shared-model').keyScores[0].score;
  const expensive = scores[1].score.modelScores.find((item) => item.model === 'shared-model').keyScores[0].score;
  const singleton = scores[0].score.modelScores.find((item) => item.model === 'singleton-model').keyScores[0].score;
  assert.equal(cheap.priceScore, 100);
  assert.equal(expensive.priceScore, 50);
  assert.equal(singleton.priceScore, null);
  assert.equal(expensive.bestRateMultiplier, 0.05);
  assert.equal(expensive.comparableSupplierCount, 2);
});

test('three consecutive active probe failures mark a model as not recommended', () => {
  const scores = buildSupplierQualityScores({
    now: now.getTime(),
    connections: [{ id: 1 }],
    keys: [{ id: 11, connectionId: 1, status: 'active', rateMultiplier: 0.05 }],
    targets: [{ connectionId: 1, keyId: 11, model: 'unstable-model', enabled: true }],
    observations: [0, 1, 2].map((index) => observation(1, 11, 'unstable-model', {
      status: 'failed',
      ttftMs: null,
      observedAt: new Date(now.getTime() - index * 60_000).toISOString(),
    })),
  });
  const score = scores[0].score.modelScores[0].keyScores[0].score;
  assert.equal(score.consecutiveFailures, 3);
  assert.equal(score.dataStatus, 'not_recommended');
});

test('recent usage weights models while preventing one model from dominating multi-model scores', () => {
  const models = ['a', 'b', 'c'];
  const scores = buildSupplierQualityScores({
    now: now.getTime(),
    connections: [{ id: 1 }],
    keys: [{ id: 11, connectionId: 1, status: 'active', rateMultiplier: 0.05 }],
    targets: models.map((model) => ({ connectionId: 1, keyId: 11, model, enabled: true })),
    observations: models.flatMap((model) => Array.from({ length: 100 }, (_, index) => (
      observation(1, 11, model, { observedAt: new Date(now.getTime() - index * 60_000).toISOString() })
    ))),
    usageWeights: [
      { connectionId: 1, keyId: 11, model: 'a', amount: 1000 },
      { connectionId: 1, keyId: 11, model: 'b', amount: 1 },
      { connectionId: 1, keyId: 11, model: 'c', amount: 1 },
    ],
  });
  const weights = new Map(scores[0].score.modelScores.map((item) => [item.model, item.weight]));
  assert.equal(weights.get('a'), 0.4);
  assert.equal(weights.get('b'), 0.3);
  assert.equal(weights.get('c'), 0.3);
});

test('connections without models or observations remain explicitly unscored', () => {
  const [result] = buildSupplierQualityScores({
    now: now.getTime(),
    connections: [{ id: 1 }],
  });
  assert.equal(result.score.riskAdjustedScore, null);
  assert.equal(result.score.dataStatus, 'insufficient_data');
  assert.equal(result.metrics.modelCount, 0);
});
