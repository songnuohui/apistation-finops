import Decimal from 'decimal.js/decimal.mjs';

const COST_MODES = new Set([
  'probe_multiplier',
  'manual_multiplier',
  'fixed_purchase',
  'free',
]);

const BASIS_MODES = new Set(['revenue_backsolve', 'reference_cny']);

const PROBE_DATA_KEYS = [
  'object',
  'schema_version',
  'billing_scope',
  'group_rate_multiplier',
  'user_rate_multiplier',
  'resolved_rate_multiplier',
  'peak_rate_enabled',
  'peak_start',
  'peak_end',
  'peak_rate_multiplier',
  'applied_peak_multiplier',
  'effective_rate_multiplier',
  'timezone',
  'observed_at',
];

function finiteDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nonNegativeNumber(value) {
  const parsed = finiteDecimal(value);
  return parsed && parsed.gte(0) ? parsed.toString() : null;
}

function positiveNumber(value) {
  const parsed = finiteDecimal(value);
  return parsed && parsed.gt(0) ? parsed.toString() : null;
}

function objectValue(value) {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)); }
    catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function normalizeCostMode(value, fallback = 'fixed_purchase') {
  return COST_MODES.has(value) ? value : fallback;
}

export function normalizeBasisMode(value, fallback = 'revenue_backsolve') {
  return BASIS_MODES.has(value) ? value : fallback;
}

export function normalizeUpstreamBillingSnapshot(value) {
  const snapshot = objectValue(value);
  if (!snapshot) return null;
  const sourceData = objectValue(snapshot.data);
  const data = {};
  for (const key of PROBE_DATA_KEYS) {
    if (!(key in (sourceData || {}))) continue;
    const raw = sourceData[key];
    if ([
      'group_rate_multiplier',
      'user_rate_multiplier',
      'resolved_rate_multiplier',
      'peak_rate_multiplier',
      'applied_peak_multiplier',
      'effective_rate_multiplier',
    ].includes(key)) {
      const parsed = nonNegativeNumber(raw);
      if (parsed !== null) data[key] = parsed;
      continue;
    }
    if (key === 'schema_version') {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed >= 0) data[key] = parsed;
      continue;
    }
    if (key === 'peak_rate_enabled') {
      if (typeof raw === 'boolean') data[key] = raw;
      continue;
    }
    if (key === 'observed_at') {
      const parsed = timestamp(raw);
      if (parsed) data[key] = parsed;
      continue;
    }
    if (typeof raw === 'string' && raw.length <= 120) data[key] = raw;
  }

  const status = typeof snapshot.status === 'string' ? snapshot.status.slice(0, 24) : 'unknown';
  const observedAt = timestamp(data.observed_at);
  const receivedAt = timestamp(snapshot.received_at);
  const lastAttemptAt = timestamp(snapshot.last_attempt_at);
  const snapshotTime = observedAt || receivedAt || lastAttemptAt;
  if (!snapshotTime) return null;

  const failureCount = Number(snapshot.failure_count);
  const httpStatus = Number(snapshot.http_status);
  return {
    status,
    data,
    observedAt,
    receivedAt,
    freshUntil: timestamp(snapshot.fresh_until),
    lastAttemptAt,
    nextProbeAt: timestamp(snapshot.next_probe_at),
    failureCount: Number.isSafeInteger(failureCount) && failureCount >= 0 ? failureCount : 0,
    httpStatus: Number.isSafeInteger(httpStatus) && httpStatus >= 0 ? httpStatus : 0,
    lastError: typeof snapshot.last_error === 'string' ? snapshot.last_error.slice(0, 2000) : '',
    snapshotKey: [
      status,
      observedAt || '',
      receivedAt || '',
      lastAttemptAt || '',
      data.effective_rate_multiplier || '',
    ].join('|'),
    groupRateMultiplier: data.group_rate_multiplier || null,
    userRateMultiplier: data.user_rate_multiplier || null,
    resolvedRateMultiplier: data.resolved_rate_multiplier || null,
    effectiveRateMultiplier: data.effective_rate_multiplier || null,
    billingScope: typeof data.billing_scope === 'string' ? data.billing_scope : '',
    peakRateEnabled: Boolean(data.peak_rate_enabled),
    peakRateMultiplier: data.peak_rate_multiplier || null,
    appliedPeakMultiplier: data.applied_peak_multiplier || null,
    timezone: typeof data.timezone === 'string' ? data.timezone : '',
  };
}

export function calculateMultiplierCostCny({
  mode,
  basisMode,
  userChargeCny,
  standardCostReference,
  sellingMultiplier,
  upstreamMultiplier,
  cnyPerReferenceUnit,
}) {
  const normalizedMode = normalizeCostMode(mode, 'unconfigured');
  if (normalizedMode === 'free') return { status: 'free', costCny: '0' };
  if (!['probe_multiplier', 'manual_multiplier'].includes(normalizedMode)) {
    return { status: normalizedMode === 'fixed_purchase' ? 'fixed_cost' : 'unconfigured', costCny: null };
  }

  const upstream = positiveNumber(upstreamMultiplier);
  if (!upstream) return { status: 'missing_upstream_multiplier', costCny: null };

  if (normalizeBasisMode(basisMode) === 'reference_cny') {
    const reference = finiteDecimal(standardCostReference);
    const basis = positiveNumber(cnyPerReferenceUnit);
    if (!basis) return { status: 'missing_cny_basis', costCny: null };
    if (!reference || reference.lt(0)) return { status: 'invalid_reference_cost', costCny: null };
    return {
      status: 'priced',
      costCny: reference.mul(upstream).mul(basis).toString(),
    };
  }

  const charge = finiteDecimal(userChargeCny);
  const selling = positiveNumber(sellingMultiplier);
  if (!selling) return { status: 'missing_selling_multiplier', costCny: null };
  if (!charge || charge.lt(0)) return { status: 'invalid_user_charge', costCny: null };
  return {
    status: 'priced',
    costCny: charge.mul(upstream).div(selling).toString(),
  };
}

export function effectiveObservedMultiplierAt(observation, occurredAt) {
  const resolved = finiteDecimal(observation?.resolvedRateMultiplier);
  const fallback = finiteDecimal(observation?.effectiveRateMultiplier);
  if (!resolved || resolved.lt(0)) return fallback && fallback.gte(0) ? fallback.toString() : null;
  if (!observation?.peakRateEnabled) return resolved.toString();
  const peak = finiteDecimal(observation?.peakRateMultiplier);
  const start = String(observation?.peakStart || '');
  const end = String(observation?.peakEnd || '');
  const timezone = String(observation?.timezone || '');
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  const endMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(end);
  const at = new Date(occurredAt);
  if (!peak || peak.lt(0) || !match || !endMatch || !timezone || !Number.isFinite(at.getTime())) {
    return fallback && fallback.gte(0) ? fallback.toString() : null;
  }
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return fallback && fallback.gte(0) ? fallback.toString() : null;
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const currentMinute = hour * 60 + minute;
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(endMatch[1]) * 60 + Number(endMatch[2]);
  if (startMinute >= endMinute) return fallback && fallback.gte(0) ? fallback.toString() : null;
  return (currentMinute >= startMinute && currentMinute < endMinute ? resolved.mul(peak) : resolved).toString();
}

export function splitFixedCostCny(totalAmount, accountIds, strategy = 'equal', weights = {}) {
  const total = finiteDecimal(totalAmount);
  if (!total || total.lt(0) || !Array.isArray(accountIds) || !accountIds.length) {
    throw new Error('invalid fixed cost allocation');
  }
  const ids = [...new Set(accountIds.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) throw new Error('invalid fixed cost allocation');
  const candidates = ids.map((id) => {
    const raw = finiteDecimal(weights[id]);
    return { id, weight: raw && raw.gt(0) ? raw : new Decimal(0) };
  });
  const totalWeight = candidates.reduce((sum, item) => sum.plus(item.weight), new Decimal(0));
  const useWeights = strategy !== 'equal' && totalWeight.gt(0);
  let remaining = total;
  return candidates.map((item, index) => {
    const amount = index === candidates.length - 1
      ? remaining
      : useWeights
        ? total.mul(item.weight).div(totalWeight).toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
        : total.div(candidates.length).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
    remaining = remaining.minus(amount);
    return { accountId: item.id, amountCny: amount.toString() };
  });
}
