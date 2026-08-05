function bounded(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value)));
}

function rounded(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

export function ttftScore(ttftP50Ms, ttftP95Ms = null) {
  if (ttftP50Ms === null || ttftP50Ms === undefined || ttftP50Ms === '') return null;
  const p50 = Number(ttftP50Ms);
  if (!Number.isFinite(p50) || p50 < 0) return null;
  const p50Score = p50 <= 1_000 ? 100
    : p50 <= 3_000 ? 100 - (p50 - 1_000) / 2_000 * 20
      : p50 <= 10_000 ? 80 - (p50 - 3_000) / 7_000 * 40
        : p50 <= 30_000 ? 40 - (p50 - 10_000) / 20_000 * 40
          : 0;
  const p95 = Number(ttftP95Ms);
  if (!Number.isFinite(p95) || p95 < 0) return rounded(bounded(p50Score));
  const tailPenalty = p95 <= p50 * 1.5 ? 0
    : p95 <= p50 * 3 ? (p95 / p50 - 1.5) / 1.5 * 15
      : 25;
  return rounded(bounded(p50Score - tailPenalty));
}

export function stabilityScore({ ttftP50Ms, ttftP95Ms, failureCount = 0, sampleCount = 0 }) {
  if (!Number(sampleCount)) return null;
  const p50 = Number(ttftP50Ms);
  const p95 = Number(ttftP95Ms);
  const tailPenalty = Number.isFinite(p50) && p50 > 0 && Number.isFinite(p95)
    ? bounded((p95 / p50 - 1) * 18, 0, 45)
    : 15;
  const failurePenalty = bounded(Number(failureCount) / Number(sampleCount) * 100, 0, 55);
  return rounded(bounded(100 - tailPenalty - failurePenalty));
}

export function supplierQualityScore(metrics, { bestRateMultiplier = null } = {}) {
  const rate = Number(metrics.rateMultiplier);
  const bestRate = Number(bestRateMultiplier);
  const priceScore = Number.isFinite(rate) && rate > 0 && Number.isFinite(bestRate) && bestRate > 0
    ? rounded(bounded(bestRate / rate * 100))
    : null;
  const availabilityScore = Number(metrics.availabilitySamples) > 0
    ? rounded(bounded(Number(metrics.successSamples) / Number(metrics.availabilitySamples) * 100), 2)
    : null;
  const latencyScore = ttftScore(metrics.ttftP50Ms, metrics.ttftP95Ms);
  const stableScore = stabilityScore(metrics);
  const dimensions = [
    [priceScore, 35],
    [availabilityScore, 35],
    [latencyScore, 20],
    [stableScore, 10],
  ].filter(([score]) => score !== null);
  const weight = dimensions.reduce((total, [, itemWeight]) => total + itemWeight, 0);
  const overallScore = weight
    ? rounded(dimensions.reduce((total, [score, itemWeight]) => total + score * itemWeight, 0) / weight)
    : null;
  const sampleConfidence = bounded(Math.log10(Number(metrics.sampleCount || 0) + 1) / 2 * 100);
  const coverageConfidence = dimensions.length / 4 * 100;
  const confidence = rounded(sampleConfidence * 0.65 + coverageConfidence * 0.35);
  return {
    overallScore,
    priceScore,
    availabilityScore,
    latencyScore,
    stabilityScore: stableScore,
    confidence,
  };
}

export function normalizeQualityStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['operational', 'ok', 'success', 'succeeded'].includes(status)) return 'ok';
  if (['degraded', 'warning', 'slow'].includes(status)) return 'degraded';
  return 'failed';
}
