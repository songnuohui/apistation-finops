import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAdaptiveForecastParameters,
  estimateFiniteQuotaCapacity,
  forecastHourlyDemand,
} from '../src/services/replenishment-forecast.mjs';

test('finite quota capacity uses account-specific usage and a conservative P25 baseline', () => {
  const accountStates = [
    { accountId: 1, quotaUsedPercent: 50, available: true },
    { accountId: 2, quotaUsedPercent: 100, available: false },
    { accountId: 3, quotaUsedPercent: 25, available: true },
    { accountId: 4, quotaUsedPercent: 0, available: true },
  ];
  const usageRows = [
    { accountId: 1, cost: 50 },
    { accountId: 2, cost: 120 },
    { accountId: 3, cost: 40 },
  ];

  const result = estimateFiniteQuotaCapacity({ accountStates, usageRows });

  assert.equal(result.sampleCount, 3);
  assert.equal(result.conservativeAccountCapacity, 110);
  assert.equal(result.currentRemainingCapacity, 280);
  assert.equal(result.effectiveAccounts, 3);
  assert.equal(result.exhaustedAccounts, 1);
});

test('hourly forecast excludes the partial current hour and applies the safety factor', () => {
  const nowMs = Date.parse('2026-08-18T12:30:00.000Z');
  const rows = [];
  for (let offset = 1; offset <= 48; offset += 1) {
    rows.push({
      accountId: 1,
      hour: new Date(Math.floor(nowMs / 3_600_000) * 3_600_000 - offset * 3_600_000).toISOString(),
      cost: offset <= 6 ? 12 : 8,
    });
  }
  rows.push({
    accountId: 1,
    hour: new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString(),
    cost: 10_000,
  });

  const result = forecastHourlyDemand(rows, {
    nowMs,
    lookbackHours: 48,
    horizonHours: 24,
    safetyFactor: 1.2,
    timezone: 'Asia/Shanghai',
  });

  assert.equal(result.observedUsage1h, 12);
  assert.equal(result.observedUsage6h, 72);
  assert.ok(result.forecastUsage > result.rawForecastUsage);
  assert.ok(result.forecastUsage < 1_000);
});

test('capacity estimation ignores usage from a previous repaired credential generation', () => {
  const result = estimateFiniteQuotaCapacity({
    accountStates: [{
      accountId: 7,
      quotaUsedPercent: 50,
      available: true,
      capacityStartedAt: '2026-08-18T08:00:00.000Z',
    }],
    usageRows: [
      { accountId: 7, hour: '2026-08-18T07:00:00.000Z', cost: 900 },
      { accountId: 7, hour: '2026-08-18T08:00:00.000Z', cost: 25 },
      { accountId: 7, hour: '2026-08-18T09:00:00.000Z', cost: 25 },
    ],
  });

  assert.equal(result.conservativeAccountCapacity, 100);
  assert.equal(result.currentRemainingCapacity, 50);
});

test('adaptive forecast keeps a long window for stable demand', () => {
  const nowMs = Date.parse('2026-08-18T12:30:00.000Z');
  const rows = Array.from({ length: 168 }, (_, index) => ({
    accountId: 1,
    hour: new Date(Math.floor(nowMs / 3_600_000) * 3_600_000 - (index + 1) * 3_600_000).toISOString(),
    cost: 10,
  }));

  const result = deriveAdaptiveForecastParameters(rows, {
    nowMs,
    leadTimeHoursP50: 1,
    leadTimeHoursP90: 3,
    historicalSuccessRate: 0.95,
  });

  assert.equal(result.parameterMode, 'adaptive');
  assert.equal(result.lookbackHours, 168);
  assert.equal(result.lookbackReason, 'stable');
  assert.ok(result.safetyFactor >= 1.08 && result.safetyFactor <= 1.6);
  assert.ok(result.coverageHours >= 18 && result.coverageHours <= 42);
});

test('adaptive forecast shortens the window and raises protection after a demand surge', () => {
  const nowMs = Date.parse('2026-08-18T12:30:00.000Z');
  const completedEndMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const rows = Array.from({ length: 168 }, (_, index) => {
    const offset = index + 1;
    return {
      accountId: 1,
      hour: new Date(completedEndMs - offset * 3_600_000).toISOString(),
      cost: offset <= 24 ? 20 : 5,
    };
  });

  const result = deriveAdaptiveForecastParameters(rows, {
    nowMs,
    leadTimeHoursP50: 1,
    leadTimeHoursP90: 4,
    historicalSuccessRate: 0.7,
  });

  assert.equal(result.lookbackHours, 24);
  assert.equal(result.lookbackReason, 'recent_shift');
  assert.ok(result.recentDemandChange >= 1);
  assert.ok(result.safetyFactor > 1.2);
});
