function metricNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function previousDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function nameVariants(value) {
  const raw = String(value || '').trim().toLocaleLowerCase('zh-CN');
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, '').replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, '');
  if (!compact) return [];
  const variants = new Set([compact]);
  const withoutSuffix = compact.replace(/(?:分组监控|监控分组|分组|监控)$/u, '');
  if (withoutSuffix) variants.add(withoutSuffix);
  for (const match of raw.matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/gu)) {
    const content = match[1].replace(/\s+/g, '').replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, '');
    if (content) variants.add(content);
  }
  return [...variants].filter((item) => item.length >= 2);
}

function monitorMatchScore(monitor, group) {
  const monitorVariants = nameVariants(monitor?.groupName || monitor?.name);
  const groupVariants = [
    ...nameVariants(group?.name),
    ...nameVariants(group?.sourceGroupName),
  ];
  let best = 0;
  for (const monitorVariant of monitorVariants) {
    for (const groupVariant of groupVariants) {
      if (monitorVariant === groupVariant) {
        best = Math.max(best, 1_000 + monitorVariant.length);
      } else if (groupVariant.includes(monitorVariant) || monitorVariant.includes(groupVariant)) {
        best = Math.max(best, 100 + Math.min(monitorVariant.length, groupVariant.length));
      }
    }
  }
  return best;
}

function status(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'operational' || normalized === 'healthy' || normalized === 'ok') return 'healthy';
  if (normalized === 'degraded') return 'degraded';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'unavailable') return 'unavailable';
  return 'unknown';
}

function summarizeStatuses(monitors, latestByMonitor) {
  if (!monitors.length) {
    return { status: 'unknown', availableCount: 0, totalCount: 0 };
  }
  const statuses = monitors.map((monitor) => status(latestByMonitor.get(Number(monitor.id))?.status));
  const known = statuses.filter((value) => value !== 'unknown');
  const availableCount = statuses.filter((value) => value === 'healthy' || value === 'degraded').length;
  if (!known.length) return { status: 'unknown', availableCount, totalCount: monitors.length };
  if (!availableCount) return { status: 'unavailable', availableCount, totalCount: monitors.length };
  if (availableCount < monitors.length || statuses.includes('degraded')) {
    return { status: 'degraded', availableCount, totalCount: monitors.length };
  }
  return { status: 'healthy', availableCount, totalCount: monitors.length };
}

function sumStats(target, row) {
  target.total += integer(row?.totalChecks);
  target.ok += Math.min(integer(row?.totalChecks), integer(row?.okCount));
  target.sumLatency += integer(row?.sumLatencyMs);
  target.countLatency += integer(row?.countLatency);
  target.sumPingLatency += integer(row?.sumPingLatencyMs);
  target.countPingLatency += integer(row?.countPingLatency);
}

function emptyStats() {
  return {
    total: 0,
    ok: 0,
    sumLatency: 0,
    countLatency: 0,
    sumPingLatency: 0,
    countPingLatency: 0,
  };
}

function availability(stats) {
  return stats.total
    ? Number((stats.ok * 100 / stats.total).toFixed(2))
    : null;
}

function timestamp(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dateAt(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function historyStats(rows) {
  const stats = emptyStats();
  for (const row of rows) {
    stats.total += 1;
    if (status(row.status) === 'healthy' || status(row.status) === 'degraded') stats.ok += 1;
    const latency = metricNumber(row.latencyMs);
    if (latency !== null) {
      stats.sumLatency += latency;
      stats.countLatency += 1;
    }
    const pingLatency = metricNumber(row.pingLatencyMs);
    if (pingLatency !== null) {
      stats.sumPingLatency += pingLatency;
      stats.countPingLatency += 1;
    }
  }
  return stats;
}

function addStats(target, source) {
  target.total += source.total;
  target.ok += source.ok;
  target.sumLatency += source.sumLatency;
  target.countLatency += source.countLatency;
  target.sumPingLatency += source.sumPingLatency;
  target.countPingLatency += source.countPingLatency;
}

function groupHistoryRows(source, monitorIds, historyStartedAt) {
  const start = timestamp(historyStartedAt);
  return (source.histories || []).filter((row) => {
    if (!monitorIds.has(Number(row.monitorId))) return false;
    const checkedAt = timestamp(row.checkedAt);
    return checkedAt !== null && (start === null || checkedAt >= start);
  });
}

function groupWindowStats(source, monitorIds, days, historyStartedAt) {
  const stats = emptyStats();
  const today = source.todayDate;
  const cutoff = previousDate(today, days - 1);
  if (!today || !cutoff) return stats;
  const historyStartDate = dateAt(historyStartedAt);
  for (const row of source.rollups || []) {
    if (!monitorIds.has(Number(row.monitorId))) continue;
    const bucketDate = String(row.bucketDate || '').slice(0, 10);
    if (
      bucketDate >= cutoff
      && bucketDate < today
      && (!historyStartDate || bucketDate > historyStartDate)
    ) sumStats(stats, row);
  }
  if (!historyStartDate) {
    for (const row of source.todayStats || []) {
      if (monitorIds.has(Number(row.monitorId))) sumStats(stats, row);
    }
    return stats;
  }
  const directRows = groupHistoryRows(source, monitorIds, historyStartedAt).filter((row) => {
    const checkedDate = dateAt(row.checkedAt);
    return checkedDate && checkedDate >= cutoff && (checkedDate === today || checkedDate === historyStartDate);
  });
  addStats(stats, historyStats(directRows));
  return stats;
}

function historyForGroup(source, monitorIds, historyStartedAt) {
  return groupHistoryRows(source, monitorIds, historyStartedAt)
    .sort((left, right) => {
      const time = new Date(left.checkedAt).getTime() - new Date(right.checkedAt).getTime();
      return time || Number(left.id) - Number(right.id);
    })
    .slice(-60)
    .map((row) => ({
      status: status(row.status),
      latencyMs: metricNumber(row.latencyMs),
      pingLatencyMs: metricNumber(row.pingLatencyMs),
      observedAt: row.checkedAt || null,
    }));
}

function latestMetric(monitors, latestByMonitor, field) {
  const values = monitors
    .map((monitor) => metricNumber(latestByMonitor.get(Number(monitor.id))?.[field]))
    .filter((value) => value !== null);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function latestObservedAt(monitors, latestByMonitor, historyStartedAt) {
  const start = timestamp(historyStartedAt);
  const timestamps = monitors
    .map((monitor) => latestByMonitor.get(Number(monitor.id))?.checkedAt || null)
    .map((value) => new Date(value || '').getTime())
    .filter((value) => Number.isFinite(value) && (start === null || value >= start));
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function groupData(group, source) {
  const monitors = (source.monitors || []).filter((monitor) => (
    monitor?.enabled !== false && monitorMatchScore(monitor, group) > 0
  ));
  const monitorIds = new Set(monitors.map((monitor) => Number(monitor.id)));
  const latestByMonitor = new Map(
    (source.latest || [])
      .filter((row) => {
        const start = timestamp(group.historyStartedAt);
        const checkedAt = timestamp(row.checkedAt);
        return checkedAt !== null && (start === null || checkedAt >= start);
      })
      .map((row) => [Number(row.monitorId), row]),
  );
  const current = summarizeStatuses(monitors, latestByMonitor);
  const statsByWindow = Object.fromEntries(
    [7, 15, 30].map((days) => [days, groupWindowStats(source, monitorIds, days, group.historyStartedAt)]),
  );
  const sourceGroupMultiplier = metricNumber(group.sourceGroupMultiplier);
  const currentMultiplier = group.displayMultiplier ?? sourceGroupMultiplier;
  const availabilityByWindow = {
    '7d': availability(statsByWindow[7]),
    '15d': availability(statsByWindow[15]),
    '30d': availability(statsByWindow[30]),
  };
  const availabilitySampleCount = {
    '7d': statsByWindow[7].total,
    '15d': statsByWindow[15].total,
    '30d': statsByWindow[30].total,
  };
  const provider = group.provider || monitors[0]?.provider || '';
  return {
    ...group,
    provider,
    status: current.status,
    availableAccountCount: current.availableCount,
    totalAccountCount: current.totalCount,
    currentMultiplier,
    configuredGroupMultiplier: currentMultiplier,
    averageLatencyMs: latestMetric(monitors, latestByMonitor, 'latencyMs'),
    averagePingLatencyMs: latestMetric(monitors, latestByMonitor, 'pingLatencyMs'),
    lastObservedAt: latestObservedAt(monitors, latestByMonitor, group.historyStartedAt),
    availabilityByWindow,
    availabilitySampleCount,
    availabilityPercent: availabilityByWindow['7d'],
    history: historyForGroup(source, monitorIds, group.historyStartedAt),
  };
}

function overallStatus(groups) {
  const healthyGroups = groups.filter((group) => group.status === 'healthy').length;
  const degradedGroups = groups.filter((group) => group.status === 'degraded').length;
  const unavailableGroups = groups.filter((group) => group.status === 'unavailable').length;
  const knownGroups = healthyGroups + degradedGroups + unavailableGroups;
  return {
    overallStatus: !groups.length || knownGroups === 0
      ? 'unknown'
      : unavailableGroups > 0
        ? 'unavailable'
        : degradedGroups > 0 || healthyGroups < groups.length
          ? 'degraded'
          : 'healthy',
    healthyGroups,
    degradedGroups,
    unavailableGroups,
  };
}

export class Sub2ApiGroupMonitorService {
  constructor(repository, sourceReader, config, logger = console) {
    this.repository = repository;
    this.sourceReader = sourceReader;
    this.maximumCacheTtlMs = Math.max(1, Number(config?.sub2apiUsageCacheTtlSeconds || 30)) * 1_000;
    this.logger = logger;
    this.cached = null;
    this.cachedAt = 0;
    this.inflight = null;
    this.cacheGeneration = 0;
  }

  clearCache() {
    this.cached = null;
    this.cachedAt = 0;
    this.cacheGeneration += 1;
  }

  cacheTtlMs() {
    const intervals = (this.cached?.groups || [])
      .map((group) => Number(group.refreshIntervalSeconds))
      .filter((value) => Number.isFinite(value) && value >= 15 && value <= 3600);
    return Math.min(
      this.maximumCacheTtlMs,
      (intervals.length ? Math.min(...intervals) : 30) * 1_000,
    );
  }

  async readGroupsUncached() {
    const configuredGroups = await this.repository.listMonitorGroups();
    let source = null;
    try {
      source = await this.sourceReader?.read();
    } catch (error) {
      this.logger.warn('[monitor] failed to read Sub2API monitor data', error?.code || error?.message || error);
    }
    const groups = configuredGroups.map((group) => groupData(group, source || {
      monitors: [],
      latest: [],
      histories: [],
      rollups: [],
      todayStats: [],
    }));
    return { groups };
  }

  async readGroups({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cachedAt < this.cacheTtlMs()) return this.cached;
    if (this.inflight) return this.inflight;
    const generation = this.cacheGeneration;
    this.inflight = this.readGroupsUncached()
      .then((result) => {
        if (generation === this.cacheGeneration) {
          this.cached = result;
          this.cachedAt = Date.now();
        }
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async listAdminGroups() {
    return (await this.readGroups()).groups;
  }

  async getPublicDashboard() {
    const { groups } = await this.readGroups();
    const publicGroups = groups
      .filter((group) => group.enabled)
      .map((group) => ({
        id: group.id,
        name: group.name,
        provider: group.provider,
        modelLabel: group.modelLabel,
        refreshIntervalSeconds: group.refreshIntervalSeconds,
        historyStartedAt: group.historyStartedAt,
        status: group.status,
        currentMultiplier: group.currentMultiplier,
        availabilityPercent: group.availabilityPercent,
        availabilityByWindow: group.availabilityByWindow,
        availabilitySampleCount: group.availabilitySampleCount,
        availableAccountCount: group.availableAccountCount,
        totalAccountCount: group.totalAccountCount,
        averageLatencyMs: group.averageLatencyMs,
        averagePingLatencyMs: group.averagePingLatencyMs,
        lastObservedAt: group.lastObservedAt,
        history: group.history,
      }));
    const summary = overallStatus(publicGroups);
    const refreshIntervals = publicGroups
      .map((group) => Number(group.refreshIntervalSeconds))
      .filter((value) => Number.isFinite(value) && value >= 15 && value <= 3600);
    return {
      generatedAt: new Date().toISOString(),
      refreshIntervalSeconds: refreshIntervals.length ? Math.min(...refreshIntervals) : 30,
      summary: {
        overallStatus: summary.overallStatus,
        totalGroups: publicGroups.length,
        healthyGroups: summary.healthyGroups,
        degradedGroups: summary.degradedGroups,
        unavailableGroups: summary.unavailableGroups,
      },
      groups: publicGroups,
    };
  }
}
