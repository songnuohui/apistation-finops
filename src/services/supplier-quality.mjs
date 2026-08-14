function bounded(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value)));
}

function rounded(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(values, percentileValue) {
  const sorted = values.filter((value) => finite(value) !== null).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function wilsonLowerBound(successes, samples, z = 1.96) {
  const success = Math.max(0, Number(successes) || 0);
  const total = Math.max(0, Number(samples) || 0);
  if (!total) return null;
  const proportion = Math.min(1, success / total);
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = proportion + zSquared / (2 * total);
  const spread = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total);
  return bounded((center - spread) / denominator, 0, 1) * 100;
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
    : p95 <= p50 * 3 ? (p95 / Math.max(p50, 1) - 1.5) / 1.5 * 15
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

function effectiveDimensions(dimensions) {
  const available = dimensions.filter(([score]) => score !== null && score !== undefined);
  const weight = available.reduce((total, [, itemWeight]) => total + itemWeight, 0);
  return { available, weight };
}

function rawScore(dimensions) {
  const { available, weight } = effectiveDimensions(dimensions);
  return weight
    ? rounded(available.reduce((total, [score, itemWeight]) => total + score * itemWeight, 0) / weight)
    : null;
}

function sourceWeight(sourceKind) {
  if (sourceKind === 'active_probe') return 1;
  if (sourceKind === 'passive_usage') return 0.85;
  if (sourceKind === 'passive_monitor') return 0.7;
  return 0.5;
}

function freshnessScore(lastSuccessAt, now = Date.now()) {
  if (!lastSuccessAt) return 0;
  const ageHours = Math.max(0, (now - new Date(lastSuccessAt).getTime()) / 3_600_000);
  if (!Number.isFinite(ageHours)) return 0;
  return bounded(100 - ageHours / 24 * 100);
}

function sourceConfidence(observations) {
  const weighted = observations.reduce((total, item) => total + sourceWeight(item.sourceKind), 0);
  const sourceKinds = new Set(observations.map((item) => item.sourceKind).filter(Boolean));
  return bounded(weighted / 20 * 100 * 0.75 + sourceKinds.size / 3 * 100 * 0.25);
}

function metricsSourceConfidence(metrics) {
  if (Array.isArray(metrics.observations) && metrics.observations.length) {
    return sourceConfidence(metrics.observations);
  }
  const counts = [
    ['passive_usage', Number(metrics.passiveUsageSamples || 0)],
    ['passive_monitor', Number(metrics.passiveMonitorSamples || 0)],
    ['active_probe', Number(metrics.activeProbeSamples || 0)],
  ];
  const weighted = counts.reduce((total, [kind, count]) => total + sourceWeight(kind) * Number(count), 0);
  const sourceKinds = counts.filter(([, count]) => Number(count) > 0).length;
  return bounded(weighted / 20 * 100 * 0.75 + sourceKinds / 3 * 100 * 0.25);
}

function normalizeModel(model) {
  return String(model || '').trim();
}

function modelMetrics(observations) {
  const availability = observations.filter((item) => item.availabilitySample);
  const successful = availability.filter((item) => item.status === 'ok');
  const failures = observations.filter((item) => item.status === 'failed');
  const ttfts = observations.map((item) => item.ttftMs).filter((value) => finite(value) !== null);
  const lastSuccess = successful
    .map((item) => item.observedAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
  const sorted = [...observations].sort((left, right) => new Date(right.observedAt || 0).getTime() - new Date(left.observedAt || 0).getTime());
  const activeProbes = sorted.filter((item) => item.sourceKind === 'active_probe');
  let consecutiveFailures = 0;
  for (const item of activeProbes) {
    if (item.status !== 'failed') break;
    consecutiveFailures += 1;
  }
  return {
    sampleCount: observations.length,
    availabilitySamples: availability.length,
    successSamples: successful.length,
    failureCount: failures.length,
    ttftP50Ms: percentile(ttfts, 0.5),
    ttftP95Ms: percentile(ttfts, 0.95),
    lastObservedAt: sorted[0]?.observedAt || null,
    lastSuccessAt: lastSuccess,
    consecutiveFailures,
    passiveUsageSamples: observations.filter((item) => item.sourceKind === 'passive_usage').length,
    passiveMonitorSamples: observations.filter((item) => item.sourceKind === 'passive_monitor').length,
    activeProbeSamples: observations.filter((item) => item.sourceKind === 'active_probe').length,
  };
}

function latestObservedRate(observations) {
  return [...observations]
    .filter((item) => item.status === 'ok' && finite(item.rateMultiplier) !== null && Number(item.rateMultiplier) > 0)
    .sort((left, right) => new Date(right.observedAt || 0).getTime() - new Date(left.observedAt || 0).getTime())
    .map((item) => Number(item.rateMultiplier))[0] ?? null;
}

function metricSummaryKey(level, connectionId, model = '', keyId = null) {
  return `${level}\u0000${Number(connectionId)}\u0000${normalizeModel(model)}\u0000${keyId === null || keyId === undefined ? '' : Number(keyId)}`;
}

function summarizedMetrics(summary = {}) {
  return {
    sampleCount: Number(summary.sampleCount || 0),
    availabilitySamples: Number(summary.availabilitySamples || 0),
    successSamples: Number(summary.successSamples || 0),
    failureCount: Number(summary.failureCount || 0),
    ttftP50Ms: finite(summary.ttftP50Ms),
    ttftP95Ms: finite(summary.ttftP95Ms),
    lastObservedAt: summary.lastObservedAt || null,
    lastSuccessAt: summary.lastSuccessAt || null,
    consecutiveFailures: Number(summary.consecutiveFailures || 0),
    passiveUsageSamples: Number(summary.passiveUsageSamples || 0),
    passiveMonitorSamples: Number(summary.passiveMonitorSamples || 0),
    activeProbeSamples: Number(summary.activeProbeSamples || 0),
  };
}

function newerDate(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function weightedPercentile(left, right, field) {
  const leftValue = finite(left?.[field]);
  const rightValue = finite(right?.[field]);
  const leftSamples = Number(left?.ttftSamples || 0);
  const rightSamples = Number(right?.ttftSamples || 0);
  if (leftValue === null) return rightValue;
  if (rightValue === null) return leftValue;
  const total = leftSamples + rightSamples;
  return total ? (leftValue * leftSamples + rightValue * rightSamples) / total : leftValue;
}

function mergeMetricSummaries(left = null, right = null) {
  if (!left) return right || {};
  if (!right) return left;
  return {
    ...left,
    sampleCount: Number(left.sampleCount || 0) + Number(right.sampleCount || 0),
    availabilitySamples: Number(left.availabilitySamples || 0) + Number(right.availabilitySamples || 0),
    successSamples: Number(left.successSamples || 0) + Number(right.successSamples || 0),
    failureCount: Number(left.failureCount || 0) + Number(right.failureCount || 0),
    ttftSamples: Number(left.ttftSamples || 0) + Number(right.ttftSamples || 0),
    ttftP50Ms: weightedPercentile(left, right, 'ttftP50Ms'),
    ttftP95Ms: weightedPercentile(left, right, 'ttftP95Ms'),
    lastObservedAt: newerDate(left.lastObservedAt, right.lastObservedAt),
    lastSuccessAt: newerDate(left.lastSuccessAt, right.lastSuccessAt),
    consecutiveFailures: Math.max(Number(left.consecutiveFailures || 0), Number(right.consecutiveFailures || 0)),
    passiveUsageSamples: Number(left.passiveUsageSamples || 0) + Number(right.passiveUsageSamples || 0),
    passiveMonitorSamples: Number(left.passiveMonitorSamples || 0) + Number(right.passiveMonitorSamples || 0),
    activeProbeSamples: Number(left.activeProbeSamples || 0) + Number(right.activeProbeSamples || 0),
    latestRateMultiplier: left.latestRateMultiplier ?? right.latestRateMultiplier ?? null,
    latestPassiveRateMultiplier: left.latestPassiveRateMultiplier ?? right.latestPassiveRateMultiplier ?? null,
  };
}

function activeKeyRate(keys, keyIds = null) {
  const allowed = keyIds && keyIds.size ? keys.filter((key) => keyIds.has(Number(key.id))) : keys;
  const rates = allowed
    .filter((key) => key.status === 'active' && !key.removedAt && finite(key.rateMultiplier) !== null && Number(key.rateMultiplier) > 0)
    .map((key) => Number(key.rateMultiplier));
  return rates.length ? Math.min(...rates) : null;
}

function rateForModel(observations, keys) {
  const keyIds = new Set(observations.map((item) => Number(item.keyId)).filter((item) => Number.isFinite(item) && item > 0));
  const inventory = activeKeyRate(keys, keyIds);
  if (inventory !== null) return { value: inventory, source: 'supplier_key' };
  const observed = latestObservedRate(observations.filter((item) => item.sourceKind === 'passive_usage'));
  if (observed !== null) return { value: observed, source: 'passive_usage' };
  const fallback = activeKeyRate(keys);
  return fallback === null ? { value: null, source: '' } : { value: fallback, source: 'supplier_key' };
}

function rateForSummary(summary, keys) {
  const inventory = activeKeyRate(keys);
  if (inventory !== null) return { value: inventory, source: 'supplier_key' };
  const observed = finite(summary?.latestPassiveRateMultiplier);
  if (observed !== null && observed > 0) return { value: observed, source: 'passive_usage' };
  return { value: null, source: '' };
}

function buildModelScore(metrics, {
  rateMultiplier = null,
  rateSource = '',
  bestRateMultiplier = null,
  comparableSupplierCount = 0,
  now = Date.now(),
  targetFailures = 0,
} = {}) {
  const priceScore = comparableSupplierCount > 1
    && finite(rateMultiplier) !== null
    && finite(bestRateMultiplier) !== null
    && Number(rateMultiplier) > 0
    && Number(bestRateMultiplier) > 0
    ? rounded(bounded(Number(bestRateMultiplier) / Number(rateMultiplier) * 100))
    : null;
  const availabilityScore = wilsonLowerBound(metrics.successSamples, metrics.availabilitySamples);
  const latencyScore = ttftScore(metrics.ttftP50Ms, metrics.ttftP95Ms);
  const stableScore = stabilityScore(metrics);
  const rawOverallScore = rawScore([
    [priceScore, 30],
    [availabilityScore, 35],
    [latencyScore, 20],
    [stableScore, 15],
  ]);
  let cappedScore = rawOverallScore;
  if (cappedScore !== null && availabilityScore !== null) {
    if (availabilityScore < 90) cappedScore = Math.min(cappedScore, 59);
    else if (availabilityScore < 98) cappedScore = Math.min(cappedScore, 79);
  }
  const lastSuccessAge = metrics.lastSuccessAt ? Math.max(0, (now - new Date(metrics.lastSuccessAt).getTime()) / 3_600_000) : null;
  const dataExpired = !metrics.lastSuccessAt || !Number.isFinite(lastSuccessAge) || lastSuccessAge > 24;
  const consecutiveProbeFailures = Math.max(Number(targetFailures) || 0, Number(metrics.consecutiveFailures) || 0);
  const status = consecutiveProbeFailures >= 3 ? 'not_recommended'
    : dataExpired ? 'data_expired'
      : cappedScore === null ? 'insufficient_data'
        : availabilityScore !== null && availabilityScore < 90 ? 'unavailable'
          : 'ready';
  const sampleConfidence = bounded(Math.log10(Number(metrics.sampleCount || 0) + 1) / 2 * 100);
  const freshness = freshnessScore(metrics.lastSuccessAt, now);
  const coverage = effectiveDimensions([
    [priceScore, 30], [availabilityScore, 35], [latencyScore, 20], [stableScore, 15],
  ]).available.length / 4 * 100;
  const confidence = rounded(sampleConfidence * 0.4 + freshness * 0.25 + coverage * 0.2 + metricsSourceConfidence(metrics) * 0.15);
  const riskAdjustedScore = cappedScore === null ? null : rounded(cappedScore * (0.6 + 0.4 * confidence / 100));
  return {
    overallScore: riskAdjustedScore,
    riskAdjustedScore,
    rawOverallScore: cappedScore,
    priceScore,
    availabilityScore: availabilityScore === null ? null : rounded(availabilityScore, 2),
    latencyScore,
    stabilityScore: stableScore,
    confidence,
    dataStatus: status,
    priceMultiplier: finite(rateMultiplier),
    priceSource: rateSource,
    bestRateMultiplier: finite(bestRateMultiplier),
    comparableSupplierCount: Number(comparableSupplierCount || 0),
    consecutiveFailures: consecutiveProbeFailures,
  };
}

function normalizedWeights(items, usageWeights, keyForItem, maximumWeight = 1) {
  if (!items.length) return [];
  const usage = items.map((item) => Math.max(0, Number(usageWeights.get(keyForItem(item)) || 0)));
  const total = usage.reduce((sum, value) => sum + value, 0);
  const cap = Math.max(Number(maximumWeight || 1), 1 / items.length);
  const weights = total > 0 ? usage.map((value) => value / total) : items.map(() => 1 / items.length);
  const fixed = new Set();
  while (weights.some((value, index) => !fixed.has(index) && value > cap + 1e-9)) {
    let excess = 0;
    weights.forEach((value, index) => {
      if (!fixed.has(index) && value > cap) {
        excess += value - cap;
        weights[index] = cap;
        fixed.add(index);
      }
    });
    const candidates = weights.map((value, index) => ({ value, index }))
      .filter((item) => !fixed.has(item.index));
    const candidateUsage = candidates.reduce((sum, item) => sum + usage[item.index], 0);
    candidates.forEach((item) => {
      weights[item.index] += excess * (candidateUsage > 0 ? usage[item.index] / candidateUsage : 1 / candidates.length);
    });
  }
  const normalizedTotal = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => rounded(value / normalizedTotal, 4));
}

function weightedItems(items, usageWeights, keyForItem, maximumWeight = 1) {
  const weights = normalizedWeights(items, usageWeights, keyForItem, maximumWeight);
  return items.map((item, index) => ({ ...item, weight: weights[index] }));
}

function weightedField(items, field) {
  const available = items.filter((item) => item.score[field] !== null && item.score[field] !== undefined);
  const totalWeight = available.reduce((total, item) => total + Number(item.weight || 0), 0);
  if (!totalWeight) return null;
  return rounded(available.reduce((total, item) => total + Number(item.score[field]) * Number(item.weight || 0), 0) / totalWeight);
}

function aggregateScores(items) {
  if (!items.length) {
    return {
      overallScore: null,
      riskAdjustedScore: null,
      rawOverallScore: null,
      priceScore: null,
      availabilityScore: null,
      latencyScore: null,
      stabilityScore: null,
      confidence: null,
      dataStatus: 'insufficient_data',
    };
  }
  const statuses = [...new Set(items.map((item) => item.score.dataStatus))];
  const availabilityScore = weightedField(items, 'availabilityScore');
  return {
    overallScore: weightedField(items, 'riskAdjustedScore'),
    riskAdjustedScore: weightedField(items, 'riskAdjustedScore'),
    rawOverallScore: weightedField(items, 'rawOverallScore'),
    priceScore: weightedField(items, 'priceScore'),
    availabilityScore,
    latencyScore: weightedField(items, 'latencyScore'),
    stabilityScore: weightedField(items, 'stabilityScore'),
    confidence: weightedField(items, 'confidence'),
    dataStatus: statuses.includes('not_recommended') ? 'not_recommended'
      : statuses.every((status) => status === 'insufficient_data') ? 'insufficient_data'
        : statuses.every((status) => ['data_expired', 'insufficient_data'].includes(status)) ? 'data_expired'
          : availabilityScore !== null && availabilityScore < 90 ? 'unavailable' : 'ready',
  };
}

export function buildSupplierQualityScores({
  connections = [],
  observations = [],
  observationMetrics = [],
  keys = [],
  targets = [],
  usageWeights = [],
  now = Date.now(),
} = {}) {
  const hasSummaries = observationMetrics.length > 0;
  const summaryRows = observationMetrics.map((item) => ({
    ...item,
    level: String(item.level || ''),
    connectionId: Number(item.connectionId),
    model: normalizeModel(item.model),
    keyId: finite(item.keyId),
  }));
  const summaries = new Map(summaryRows.map((item) => [
    metricSummaryKey(item.level, item.connectionId, item.model, item.keyId),
    item,
  ]));
  const summaryFor = (level, connectionId, model = '', keyId = null) => (
    summaries.get(metricSummaryKey(level, connectionId, model, keyId)) || {}
  );
  const unitSummaryFor = (connectionId, model, keyId) => {
    const direct = summaryFor('unit', connectionId, model, keyId);
    if (keyId === null || keyId === undefined) return direct;
    return mergeMetricSummaries(direct, summaryFor('unit', connectionId, model, null));
  };
  const usageByConnection = new Map();
  for (const item of usageWeights) {
    const connectionId = Number(item.connectionId);
    if (!usageByConnection.has(connectionId)) usageByConnection.set(connectionId, { models: new Map(), keys: new Map() });
    const model = normalizeModel(item.model);
    const amount = Number(item.amount || 0);
    const bucket = usageByConnection.get(connectionId);
    bucket.models.set(model, Number(bucket.models.get(model) || 0) + amount);
    if (item.keyId !== null && item.keyId !== undefined) {
      const key = `${Number(item.keyId)}\u0000${model}`;
      bucket.keys.set(key, Number(bucket.keys.get(key) || 0) + amount);
    }
  }
  const descriptors = [];
  for (const connection of connections) {
    const connectionId = Number(connection.id);
    const connectionObservations = hasSummaries
      ? []
      : observations.filter((item) => Number(item.connectionId) === connectionId);
    const connectionKeys = keys.filter((item) => Number(item.connectionId) === connectionId);
    const connectionTargets = targets.filter((item) => Number(item.connectionId) === connectionId && item.enabled);
    const modelNames = new Set([
      ...connectionObservations.map((item) => normalizeModel(item.model)).filter(Boolean),
      ...summaryRows.filter((item) => item.level === 'model' && item.connectionId === connectionId)
        .map((item) => item.model).filter(Boolean),
      ...connectionTargets.map((item) => normalizeModel(item.model)).filter(Boolean),
    ]);
    for (const model of modelNames) {
      const modelObservations = connectionObservations.filter((item) => normalizeModel(item.model) === model);
      const modelTargets = connectionTargets.filter((item) => normalizeModel(item.model) === model);
      const keyIds = new Set([
        ...modelObservations.map((item) => finite(item.keyId)).filter((item) => item !== null && item > 0),
        ...summaryRows.filter((item) => item.level === 'unit' && item.connectionId === connectionId && item.model === model)
          .map((item) => item.keyId).filter((item) => item !== null && item > 0),
        ...modelTargets.map((item) => finite(item.keyId)).filter((item) => item !== null && item > 0),
      ]);
      if (!keyIds.size) keyIds.add(null);
      for (const keyId of keyIds) {
        const key = keyId === null ? null : connectionKeys.find((item) => Number(item.id) === Number(keyId));
        const unitObservations = modelObservations.filter((item) => (
          finite(item.keyId) === null || keyId === null || Number(item.keyId) === Number(keyId)
        ));
        const summary = hasSummaries ? unitSummaryFor(connectionId, model, keyId) : null;
        const rate = hasSummaries
          ? rateForSummary(summary, key ? [key] : connectionKeys)
          : rateForModel(unitObservations, key ? [key] : connectionKeys);
        descriptors.push({
          connectionId,
          model,
          keyId,
          key,
          observations: unitObservations,
          summary,
          modelObservations,
          targets: modelTargets.filter((item) => keyId === null || Number(item.keyId) === Number(keyId)),
          rate,
        });
      }
    }
  }
  const marketRates = new Map();
  for (const model of new Set(descriptors.map((item) => item.model))) {
    const modelDescriptors = descriptors.filter((item) => item.model === model && finite(item.rate.value) !== null && item.rate.value > 0);
    const rates = modelDescriptors.map((item) => item.rate.value);
    marketRates.set(model, {
      best: rates.length ? Math.min(...rates) : null,
      comparableSupplierCount: new Set(modelDescriptors.map((item) => item.connectionId)).size,
    });
  }
  return connections.map((connection) => {
    const connectionId = Number(connection.id);
    const connectionObservations = hasSummaries
      ? []
      : observations.filter((item) => Number(item.connectionId) === connectionId);
    const connectionKeys = keys.filter((item) => Number(item.connectionId) === connectionId);
    const connectionTargets = targets.filter((item) => Number(item.connectionId) === connectionId);
    const modelNames = [...new Set(descriptors.filter((item) => item.connectionId === connectionId).map((item) => item.model))]
      .sort((left, right) => left.localeCompare(right));
    const usage = usageByConnection.get(connectionId) || { models: new Map(), keys: new Map() };
    const modelScores = modelNames.map((model) => {
      const modelObservations = connectionObservations.filter((item) => normalizeModel(item.model) === model);
      const metrics = hasSummaries
        ? summarizedMetrics(summaryFor('model', connectionId, model))
        : modelMetrics(modelObservations);
      if (!hasSummaries) metrics.observations = modelObservations;
      const market = marketRates.get(model) || { best: null, comparableSupplierCount: 0 };
      const keyScores = descriptors
        .filter((item) => item.connectionId === connectionId && item.model === model)
        .map((descriptor) => {
          const unitMetrics = hasSummaries
            ? summarizedMetrics(descriptor.summary)
            : modelMetrics(descriptor.observations);
          if (!hasSummaries) unitMetrics.observations = descriptor.observations;
          return {
            keyId: descriptor.keyId,
            keyName: descriptor.key?.name || '',
            maskedKey: descriptor.key?.maskedKey || '',
            groupName: descriptor.key?.groupName || '',
            metrics: { ...unitMetrics, observations: undefined },
            score: buildModelScore(unitMetrics, {
              rateMultiplier: descriptor.rate.value,
              rateSource: descriptor.rate.source,
              bestRateMultiplier: market.best,
              comparableSupplierCount: market.comparableSupplierCount,
              now,
              targetFailures: descriptor.targets.filter((item) => item.lastStatus === 'failed').length,
            }),
          };
        });
      const weightedKeys = weightedItems(
        keyScores,
        usage.keys,
        (item) => `${Number(item.keyId)}\u0000${model}`,
      );
      return {
        model,
        metrics: { ...metrics, observations: undefined },
        score: aggregateScores(weightedKeys),
        keyScores: weightedKeys,
      };
    });
    const weighted = weightedItems(modelScores, usage.models, (item) => item.model, 0.4);
    const metrics = hasSummaries
      ? summarizedMetrics(summaryFor('connection', connectionId))
      : modelMetrics(connectionObservations);
    metrics.rateMultiplier = hasSummaries
      ? finite(summaryFor('connection', connectionId).latestRateMultiplier) ?? activeKeyRate(connectionKeys)
      : latestObservedRate(connectionObservations) ?? activeKeyRate(connectionKeys);
    metrics.modelsWithData = modelScores.filter((item) => item.metrics.sampleCount > 0).length;
    metrics.modelCount = modelScores.length;
    const score = aggregateScores(weighted);
    return {
      connection,
      score: {
        ...score,
        modelScores: weighted,
      },
      metrics,
      models: modelNames,
    };
  });
}

export function supplierQualityScore(metrics, options = {}) {
  const result = buildModelScore({
    ...metrics,
    observations: metrics.observations || [],
  }, {
    bestRateMultiplier: options.bestRateMultiplier ?? null,
    rateMultiplier: metrics.rateMultiplier ?? null,
    comparableSupplierCount: options.comparableSupplierCount ?? (options.bestRateMultiplier ? 2 : 0),
    rateSource: options.rateSource || '',
    targetFailures: options.targetFailures || 0,
    now: options.now ?? Date.now(),
  });
  return result;
}

export function normalizeQualityStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['operational', 'ok', 'success', 'succeeded'].includes(status)) return 'ok';
  if (['degraded', 'warning', 'slow'].includes(status)) return 'degraded';
  return 'failed';
}
