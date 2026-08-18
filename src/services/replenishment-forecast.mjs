const HOUR_MS = 60 * 60 * 1000;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + finite(value), 0) / values.length : 0;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (finite(value) - mean) ** 2)));
}

export function percentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = bounded(Number(ratio) || 0, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function localHour(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Number(parts.find((entry) => entry.type === 'hour')?.value || 0);
}

function recentAverage(series, count) {
  return average(series.slice(-Math.min(series.length, count)));
}

function hourlySeries(rows, { nowMs, lookbackHours }) {
  const completedEndMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const startMs = completedEndMs - lookbackHours * HOUR_MS;
  const hourly = Array.from({ length: lookbackHours }, () => 0);

  for (const row of rows || []) {
    const hourMs = Date.parse(row.hour);
    if (!Number.isFinite(hourMs) || hourMs < startMs || hourMs >= completedEndMs) continue;
    const index = Math.floor((hourMs - startMs) / HOUR_MS);
    if (index >= 0 && index < hourly.length) hourly[index] += Math.max(0, finite(row.cost));
  }

  return { completedEndMs, startMs, hourly };
}

function confidenceFor(hourly) {
  const nonZeroHours = hourly.filter((value) => value > 0).length;
  const totalObservedUsage = hourly.reduce((sum, value) => sum + value, 0);
  const confidence = totalObservedUsage <= 0
    ? 'insufficient'
    : nonZeroHours >= 72
      ? 'high'
      : nonZeroHours >= 24
        ? 'medium'
        : 'low';
  return { confidence, nonZeroHours, totalObservedUsage };
}

export function deriveAdaptiveForecastParameters(rows, {
  nowMs = Date.now(),
  maximumLookbackHours = 168,
  leadTimeHoursP50 = null,
  leadTimeHoursP90 = null,
  historicalSuccessRate = null,
} = {}) {
  const maximumLookback = Math.max(168, Math.floor(finite(maximumLookbackHours, 168)));
  const { hourly } = hourlySeries(rows, { nowMs, lookbackHours: maximumLookback });
  const fullStats = confidenceFor(hourly);
  const recent24Rate = recentAverage(hourly, 24);
  const previous24 = hourly.slice(-48, -24);
  const previous24Rate = average(previous24);
  const recentDemandChange = previous24Rate > 0
    ? bounded((recent24Rate - previous24Rate) / previous24Rate, -1, 3)
    : recent24Rate > 0
      ? 1
      : 0;
  const recent72 = hourly.slice(-72);
  const first36Rate = average(recent72.slice(0, 36));
  const last36Rate = average(recent72.slice(-36));
  const mediumTrend = first36Rate > 0
    ? bounded((last36Rate - first36Rate) / first36Rate, -1, 3)
    : last36Rate > 0
      ? 1
      : 0;

  let lookbackHours = maximumLookback;
  let lookbackReason = 'stable';
  if (fullStats.confidence === 'insufficient' || fullStats.nonZeroHours < 24) {
    lookbackReason = fullStats.confidence === 'insufficient' ? 'insufficient' : 'sparse';
  } else if (Math.abs(recentDemandChange) >= 0.5) {
    lookbackHours = 24;
    lookbackReason = 'recent_shift';
  } else if (Math.abs(recentDemandChange) >= 0.2 || Math.abs(mediumTrend) >= 0.25) {
    lookbackHours = 72;
    lookbackReason = 'trend';
  }

  const selectedHourly = hourly.slice(-lookbackHours);
  const selectedStats = confidenceFor(selectedHourly);
  const meanRate = average(selectedHourly);
  const volatility = meanRate > 0
    ? bounded(standardDeviation(selectedHourly) / meanRate, 0, 3)
    : 0;
  const successRate = Number.isFinite(Number(historicalSuccessRate))
    ? bounded(historicalSuccessRate, 0.1, 1)
    : 0.8;
  const confidencePenalty = {
    high: 0,
    medium: 0.04,
    low: 0.1,
    insufficient: 0.18,
  }[selectedStats.confidence] ?? 0.1;
  const upwardShiftPenalty = Math.max(0, recentDemandChange) * 0.12;
  const instabilityPenalty = Math.abs(Math.min(0, recentDemandChange)) * 0.04;
  const safetyFactor = bounded(
    1.08
      + Math.min(0.28, volatility * 0.12)
      + Math.min(0.15, upwardShiftPenalty + instabilityPenalty)
      + confidencePenalty
      + (1 - successRate) * 0.25,
    1.08,
    1.6,
  );

  const leadP90 = Number(leadTimeHoursP90) > 0 ? Number(leadTimeHoursP90) : 2;
  const leadP50 = Number(leadTimeHoursP50) > 0
    ? Math.min(Number(leadTimeHoursP50), leadP90)
    : Math.min(leadP90, 1);
  const leadSpread = Math.max(0, leadP90 - leadP50);
  const coverageRaw = 18
    + Math.min(12, volatility * 6)
    + Math.min(6, leadSpread * 1.5)
    + (1 - successRate) * 12
    + (selectedStats.confidence === 'insufficient'
      ? 12
      : selectedStats.confidence === 'low'
        ? 6
        : selectedStats.confidence === 'medium'
          ? 3
          : 0)
    + Math.min(6, Math.max(0, recentDemandChange) * 6);
  const coverageHours = bounded(Math.ceil(coverageRaw / 6) * 6, 18, 42);

  return {
    parameterMode: 'adaptive',
    maximumLookbackHours: maximumLookback,
    lookbackHours,
    lookbackReason,
    coverageHours,
    safetyFactor: rounded(safetyFactor, 4),
    volatility: rounded(volatility, 4),
    recentDemandChange: rounded(recentDemandChange, 4),
    mediumTrend: rounded(mediumTrend, 4),
    confidence: selectedStats.confidence,
    nonZeroHours: selectedStats.nonZeroHours,
    historicalSuccessRate: rounded(successRate, 4),
    leadTimeHoursP50: rounded(leadP50, 3),
    leadTimeHoursP90: rounded(leadP90, 3),
  };
}

export function forecastHourlyDemand(rows, {
  nowMs = Date.now(),
  lookbackHours = 168,
  horizonHours = 26,
  safetyFactor = 1.2,
  timezone = 'Asia/Shanghai',
} = {}) {
  const normalizedLookback = Math.max(24, Math.floor(finite(lookbackHours, 168)));
  const normalizedHorizon = Math.max(1, Math.ceil(finite(horizonHours, 26)));
  const { completedEndMs, startMs, hourly } = hourlySeries(rows, {
    nowMs,
    lookbackHours: normalizedLookback,
  });

  const observedUsage1h = recentAverage(hourly, 1);
  const observedUsage6h = recentAverage(hourly, 6) * 6;
  const observedUsage24h = recentAverage(hourly, 24) * 24;
  const recent1hRate = observedUsage1h;
  const recent6hRate = observedUsage6h / 6;
  const recent24hRate = observedUsage24h / 24;
  const previous18 = hourly.slice(-24, -6);
  const previousRate = average(previous18);
  const trend = previousRate > 0
    ? bounded(recent6hRate / previousRate, 0.75, 1.5)
    : 1;
  const recentRate = recent1hRate * 0.45 + recent6hRate * 0.35 + recent24hRate * 0.2;
  const byLocalHour = new Map();
  hourly.forEach((value, index) => {
    const bucketMs = startMs + index * HOUR_MS;
    const hour = localHour(bucketMs, timezone);
    if (!byLocalHour.has(hour)) byLocalHour.set(hour, []);
    byLocalHour.get(hour).push(value);
  });

  let rawForecastUsage = 0;
  for (let offset = 0; offset < normalizedHorizon; offset += 1) {
    const futureMs = completedEndMs + offset * HOUR_MS;
    const seasonalSamples = byLocalHour.get(localHour(futureMs, timezone)) || [];
    const seasonalRate = percentile(seasonalSamples.slice(-7), 0.5) ?? recent24hRate;
    const recentWeight = 0.4 * Math.pow(0.97, offset);
    const predictedRate = Math.max(
      0,
      (seasonalRate * (1 - recentWeight) + recentRate * recentWeight) * trend,
    );
    rawForecastUsage += predictedRate;
  }

  const { nonZeroHours, confidence } = confidenceFor(hourly);

  return {
    lookbackHours: normalizedLookback,
    horizonHours: normalizedHorizon,
    completedThrough: new Date(completedEndMs).toISOString(),
    observedUsage1h: rounded(observedUsage1h),
    observedUsage6h: rounded(observedUsage6h),
    observedUsage24h: rounded(observedUsage24h),
    recentHourlyRate: rounded(recentRate),
    trendFactor: rounded(trend, 4),
    rawForecastUsage: rounded(rawForecastUsage),
    safetyFactor: rounded(bounded(finite(safetyFactor, 1.2), 1, 3), 4),
    forecastUsage: rounded(rawForecastUsage * bounded(finite(safetyFactor, 1.2), 1, 3)),
    nonZeroHours,
    confidence,
  };
}

export function estimateFiniteQuotaCapacity({
  accountStates = [],
  usageRows = [],
  defaultAccountCapacity = null,
  minimumSamples = 3,
} = {}) {
  const usageByAccount = new Map();
  for (const row of usageRows) {
    const accountId = Number(row.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
    if (!usageByAccount.has(accountId)) usageByAccount.set(accountId, []);
    usageByAccount.get(accountId).push(row);
  }

  const estimates = accountStates.map((account) => {
    const accountId = Number(account.accountId);
    const usedPercent = bounded(finite(account.quotaUsedPercent, Number.NaN), 0, 100);
    const capacityStartedMs = Date.parse(account.capacityStartedAt || account.createdAt || '');
    const observedUsage = (usageByAccount.get(accountId) || [])
      .filter((row) => {
        if (!Number.isFinite(capacityStartedMs)) return true;
        const hourMs = Date.parse(row.hour);
        return !Number.isFinite(hourMs) || hourMs >= capacityStartedMs;
      })
      .reduce((sum, row) => sum + Math.max(0, finite(row.cost)), 0);
    const estimatedCapacity = Number.isFinite(usedPercent) && usedPercent >= 10 && observedUsage > 0
      ? observedUsage / (usedPercent / 100)
      : null;
    const available = Boolean(account.available) && Number.isFinite(usedPercent) && usedPercent < 100;
    const validSample = estimatedCapacity !== null
      && usedPercent >= 20
      && (available || usedPercent >= 99.5);
    return {
      accountId,
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      observedUsage,
      estimatedCapacity,
      available,
      validSample,
    };
  });
  const samples = estimates.filter((entry) => entry.validSample).map((entry) => entry.estimatedCapacity);
  const configuredDefault = Number(defaultAccountCapacity);
  const conservativeCapacity = percentile(samples, 0.25)
    ?? (Number.isFinite(configuredDefault) && configuredDefault > 0 ? configuredDefault : null);

  let currentRemainingCapacity = 0;
  let effectiveAccounts = 0;
  let unknownQuotaAccounts = 0;
  let exhaustedAccounts = 0;
  for (const entry of estimates) {
    if (entry.usedPercent === null) {
      if (entry.available) unknownQuotaAccounts += 1;
      continue;
    }
    if (entry.usedPercent >= 100) {
      exhaustedAccounts += 1;
      continue;
    }
    if (!entry.available) continue;
    effectiveAccounts += 1;
    const accountCapacity = entry.estimatedCapacity ?? conservativeCapacity;
    if (accountCapacity !== null) {
      currentRemainingCapacity += accountCapacity * (1 - entry.usedPercent / 100);
    }
  }

  return {
    conservativeAccountCapacity: rounded(conservativeCapacity),
    currentRemainingCapacity: rounded(currentRemainingCapacity),
    sampleCount: samples.length,
    confidence: samples.length >= Math.max(1, Number(minimumSamples) || 3)
      ? 'high'
      : samples.length
        ? 'low'
        : conservativeCapacity !== null
          ? 'configured'
          : 'insufficient',
    effectiveAccounts,
    unknownQuotaAccounts,
    exhaustedAccounts,
    evaluatedAccounts: estimates.length,
  };
}
