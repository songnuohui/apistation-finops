function number(value) {
  return value === null || value === undefined || value === '' ? 0 : Number(value);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pageResult(items, total, page, pageSize) {
  return { items, total, page, pageSize };
}

function financialFields(revenue, cost) {
  const normalizedRevenue = number(revenue);
  const normalizedCost = nullableNumber(cost);
  if (normalizedCost === null) {
    return {
      revenue: normalizedRevenue,
      revenueCny: normalizedRevenue,
      recognizedRevenueCny: normalizedRevenue,
      userChargeCny: normalizedRevenue,
      effectiveCostCny: null,
      fullyLoadedCostCny: null,
      bookedCostCny: null,
      cost: null,
      costCny: null,
      profit: null,
      profitCny: null,
      grossProfit: null,
      grossProfitCny: null,
      bookedProfitCny: null,
      margin: null,
      grossMargin: null,
    };
  }
  const profit = normalizedRevenue - normalizedCost;
  return {
    revenue: normalizedRevenue,
    revenueCny: normalizedRevenue,
    recognizedRevenueCny: normalizedRevenue,
    userChargeCny: normalizedRevenue,
    effectiveCostCny: normalizedCost,
    fullyLoadedCostCny: normalizedCost,
    bookedCostCny: normalizedCost,
    cost: normalizedCost,
    costCny: normalizedCost,
    profit,
    profitCny: profit,
    grossProfit: profit,
    grossProfitCny: profit,
    bookedProfitCny: profit,
    margin: normalizedRevenue ? profit / normalizedRevenue : null,
    grossMargin: normalizedRevenue ? profit / normalizedRevenue : null,
  };
}

function usageRange(input, timezone) {
  return {
    startDate: input.dailyStart,
    endDate: input.dailyEnd,
    timezone,
  };
}

function compare(field, direction) {
  const sign = direction === 'asc' ? 1 : -1;
  return (left, right) => {
    const leftValue = number(left[field]);
    const rightValue = number(right[field]);
    if (leftValue !== rightValue) return (leftValue - rightValue) * sign;
    return String(left.name || left.email || left.id || '').localeCompare(
      String(right.name || right.email || right.id || ''),
      'zh-CN',
    );
  };
}

function summarizeModels(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models.reduce((summary, item) => {
    summary.total_requests += number(item.requests);
    summary.total_input_tokens += number(item.input_tokens);
    summary.total_output_tokens += number(item.output_tokens);
    summary.total_cache_tokens += number(item.cache_creation_tokens) + number(item.cache_read_tokens);
    summary.total_tokens += number(item.total_tokens);
    summary.total_cost += number(item.cost);
    summary.total_actual_cost += number(item.actual_cost);
    summary.total_account_cost += number(item.account_cost);
    return summary;
  }, {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    total_actual_cost: 0,
    total_account_cost: 0,
  });
}

function summarizeGroups(payload) {
  const groups = (Array.isArray(payload?.groups) ? payload.groups : []).map((item) => {
    const cost = number(item.cost);
    const actualCost = number(item.actual_cost);
    const accountCost = number(item.account_cost);
    return {
      groupId: number(item.group_id),
      groupName: item.group_name || '',
      requests: number(item.requests),
      totalTokens: number(item.total_tokens),
      cost,
      actualCost,
      accountCost,
      sellingMultiplier: cost > 0 ? actualCost / cost : null,
      accountMultiplier: cost > 0 ? accountCost / cost : null,
    };
  });
  return groups.reduce((summary, group) => {
    summary.total_requests += group.requests;
    summary.total_tokens += group.totalTokens;
    summary.total_cost += group.cost;
    summary.total_actual_cost += group.actualCost;
    summary.total_account_cost += group.accountCost;
    if (group.sellingMultiplier !== null) {
      summary.selling_multiplier_min = summary.selling_multiplier_min === null
        ? group.sellingMultiplier
        : Math.min(summary.selling_multiplier_min, group.sellingMultiplier);
      summary.selling_multiplier_max = summary.selling_multiplier_max === null
        ? group.sellingMultiplier
        : Math.max(summary.selling_multiplier_max, group.sellingMultiplier);
    }
    if (group.accountMultiplier !== null) {
      summary.account_multiplier_min = summary.account_multiplier_min === null
        ? group.accountMultiplier
        : Math.min(summary.account_multiplier_min, group.accountMultiplier);
      summary.account_multiplier_max = summary.account_multiplier_max === null
        ? group.accountMultiplier
        : Math.max(summary.account_multiplier_max, group.accountMultiplier);
    }
    return summary;
  }, {
    groups,
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
    total_actual_cost: 0,
    total_account_cost: 0,
    selling_multiplier_min: null,
    selling_multiplier_max: null,
    account_multiplier_min: null,
    account_multiplier_max: null,
  });
}

function mergeAccountStats(items) {
  return items.reduce((summary, item) => {
    summary.groups.push(...(item.groups || []));
    summary.total_requests += number(item.total_requests);
    summary.total_tokens += number(item.total_tokens);
    summary.total_cost += number(item.total_cost);
    summary.total_actual_cost += number(item.total_actual_cost);
    summary.total_account_cost += number(item.total_account_cost);
    for (const field of ['selling_multiplier_min', 'account_multiplier_min']) {
      const value = nullableNumber(item[field]);
      if (value !== null) summary[field] = summary[field] === null ? value : Math.min(summary[field], value);
    }
    for (const field of ['selling_multiplier_max', 'account_multiplier_max']) {
      const value = nullableNumber(item[field]);
      if (value !== null) summary[field] = summary[field] === null ? value : Math.max(summary[field], value);
    }
    return summary;
  }, {
    groups: [],
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
    total_actual_cost: 0,
    total_account_cost: 0,
    selling_multiplier_min: null,
    selling_multiplier_max: null,
    account_multiplier_min: null,
    account_multiplier_max: null,
  });
}

function dayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dayKey(value) {
  const date = new Date(value);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function zonedDayKey(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function listDayKeys(startDay, endDay) {
  const start = dayNumber(startDay);
  const end = dayNumber(endDay);
  if (start === null || end === null || start > end) return [];
  const days = [];
  for (let current = start; current <= end; current += 86_400_000) days.push(dayKey(current));
  return days;
}

function groupMultiplierCost(groups, upstreamMultiplier) {
  return (groups || []).reduce((total, group) => {
    const upstream = nullableNumber(upstreamMultiplier);
    if (upstream === null || upstream < 0) return total;
    const selling = nullableNumber(group.sellingMultiplier);
    if (selling !== null && selling > 0) {
      return total + number(group.actualCost) / selling * upstream;
    }
    return total + number(group.cost) * upstream;
  }, 0);
}

export class SourceUsageService {
  constructor(repository, gateway, config, sourceUsageRepository = null, logger = console) {
    this.repository = repository;
    this.gateway = gateway;
    this.config = config;
    this.sourceUsageRepository = sourceUsageRepository;
    this.logger = logger;
  }

  sourceSnapshot(input, filters = {}) {
    return this.gateway.dashboardSnapshot({
      ...usageRange(input, this.config.timezone),
      ...filters,
      includeStats: false,
      includeTrend: true,
      includeModels: true,
      includeGroups: false,
      includeUsersTrend: false,
    });
  }

  summaryFrom(local, source) {
    const revenue = number(source.total_actual_cost);
    const multiplierCost = number(source.calculated_cost_cny);
    const sourceAccountCost = number(source.total_account_cost);
    const registeredProcurementCost = number(local.operations?.purchaseAllocatedCostCny);
    const effectiveCost = registeredProcurementCost + multiplierCost;
    const profit = revenue - effectiveCost;
    return {
      ...local,
      operations: {
        ...local.operations,
        consumptionCny: revenue,
        revenue,
        revenueCny: revenue,
        recognizedRevenueCny: revenue,
        userChargeCny: revenue,
        tokenListValueUsd: number(source.total_cost),
        purchaseAllocatedCostCny: registeredProcurementCost,
        allocatedCost: registeredProcurementCost,
        allocatedCostCny: registeredProcurementCost,
        registeredProcurementCostCny: registeredProcurementCost,
        multiplierCostCny: multiplierCost,
        sourceReportedAccountCostCny: sourceAccountCost,
        effectiveCostCny: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        grossProfit: profit,
        grossProfitCny: profit,
        bookedProfitCny: profit,
        grossMargin: revenue ? profit / revenue : null,
        unbookedAccountCount: number(source.missing_cost_count),
        unbookedRevenueCny: number(source.unpriced_actual_cost),
        unbookedUserChargeCny: number(source.unpriced_actual_cost),
        profitBasis: 'FinOps 账号成本规则',
      },
      usage: {
        requests: number(source.total_requests),
        inputTokens: number(source.total_input_tokens),
        outputTokens: number(source.total_output_tokens),
        cacheTokens: number(source.total_cache_tokens),
        activeUsers: 0,
        activeAccounts: number(source.active_accounts),
        averageLatencyMs: 0,
      },
    };
  }

  async getSummary(input) {
    const [local, source] = await Promise.all([
      this.repository.getSummary(input),
      this.getSourceEconomics(input),
    ]);
    return this.summaryFrom(local, source);
  }

  async getOverviewDashboard(input) {
    const [local, source, breakdown] = await Promise.all([
      this.repository.getOverviewDashboard(input),
      this.getSourceEconomics(input),
      this.gateway.dashboardUserBreakdown({
        ...usageRange(input, this.config.timezone),
        limit: 8,
        sortBy: 'total_tokens',
      }),
    ]);
    const users = Array.isArray(breakdown?.users) ? breakdown.users : [];
    const tokenUsage = users.map((item) => ({
      id: number(item.user_id),
      email: item.email || '',
      username: '',
      tokens: number(item.total_tokens),
      requests: number(item.requests),
    }));
    const summary = this.summaryFrom(local.summary || {}, source);
    summary.usage.activeUsers = users.length;
    return {
      ...local,
      generatedAt: new Date().toISOString(),
      summary,
      rankings: {
        ...local.rankings,
        tokenUsage,
        requestActivity: [...tokenUsage].sort(compare('requests', 'desc')),
      },
    };
  }

  async getTrend(input) {
    const [source, local] = await Promise.all([
      this.getSourceEconomics(input),
      this.repository.getTrend(input),
    ]);
    const sourceByDay = source.by_day || new Map();
    const localByDay = new Map((local.items || []).map((item) => [String(item.day), item]));
    const days = [...new Set([...localByDay.keys(), ...sourceByDay.keys()])].sort();
    return {
      items: days.map((day) => {
        const point = sourceByDay.get(day) || {};
        const localPoint = localByDay.get(day) || {};
        const revenue = number(point.total_actual_cost);
        const sourceCost = number(point.calculated_cost_cny);
        const registeredProcurementCost = number(localPoint.purchaseAllocatedCostCny);
        const cost = sourceCost + registeredProcurementCost;
        return {
          day,
          ...financialFields(revenue, cost),
          allocatedCost: registeredProcurementCost,
          allocatedCostCny: registeredProcurementCost,
          purchaseAllocatedCostCny: registeredProcurementCost,
          registeredProcurementCostCny: registeredProcurementCost,
          multiplierCostCny: sourceCost,
          rechargeCny: number(localPoint.rechargeCny),
        };
      }),
      rechargeEvents: local.rechargeEvents || [],
    };
  }

  async getUsageBreakdown(input) {
    const source = await this.sourceSnapshot(input);
    let items = (Array.isArray(source?.models) ? source.models : []).map((item) => {
      const revenue = number(item.actual_cost);
      const cost = number(item.account_cost);
      return {
        name: String(item.model || '').trim() || '未标注模型',
        requests: number(item.requests),
        tokens: number(item.total_tokens),
        tokenListValueUsd: number(item.cost),
        purchaseAllocatedCostCny: 0,
        multiplierCostCny: cost,
        unbookedAccountCount: 0,
        costCoverageStatus: 'source_api',
        ...financialFields(revenue, cost),
      };
    });
    const field = {
      userChargeCny: 'userChargeCny',
      requests: 'requests',
      tokens: 'tokens',
      bookedCostCny: 'bookedCostCny',
      bookedProfitCny: 'bookedProfitCny',
    }[input.sort] || 'userChargeCny';
    items = items.sort(compare(field, input.direction));
    return pageResult(
      items.slice(input.offset, input.offset + input.pageSize),
      items.length,
      input.page,
      input.pageSize,
    );
  }

  mapUserUsage(item) {
    const revenue = number(item.actual_cost);
    const cost = number(item.account_cost);
    return {
      id: number(item.user_id),
      email: item.email || '',
      username: '',
      requests: number(item.requests),
      tokens: number(item.total_tokens),
      inputTokens: number(item.input_tokens),
      outputTokens: number(item.output_tokens),
      cacheTokens: number(item.cache_tokens),
      tokenListValueUsd: number(item.cost),
      purchaseAllocatedCostCny: 0,
      multiplierCostCny: cost,
      unbookedAccountCount: 0,
      costCoverageStatus: 'complete',
      ...financialFields(revenue, cost),
    };
  }

  async listUsers(input) {
    const sourceSort = {
      requests: 'requests',
      tokens: 'total_tokens',
      userChargeCny: 'actual_cost',
      bookedCostCny: 'cost',
      bookedProfitCny: 'actual_cost',
    }[input.sort] || 'actual_cost';
    const breakdownPromise = this.gateway.dashboardUserBreakdown({
      ...usageRange(input, this.config.timezone),
      limit: 200,
      sortBy: sourceSort,
    });
    if (input.consumptionOnly) {
      const breakdown = await breakdownPromise;
      let items = (Array.isArray(breakdown?.users) ? breakdown.users : [])
        .map((item) => this.mapUserUsage(item));
      if (input.search) {
        const term = String(input.search).toLowerCase();
        items = items.filter((item) => `${item.id} ${item.email}`.toLowerCase().includes(term));
      }
      const field = input.sort === 'bookedProfitCny' ? 'bookedProfitCny'
        : input.sort === 'bookedCostCny' ? 'bookedCostCny'
        : input.sort || 'userChargeCny';
      items.sort(compare(field, input.direction));
      return pageResult(
        items.slice(input.offset, input.offset + input.pageSize),
        items.length,
        input.page,
        input.pageSize,
      );
    }

    const [local, breakdown] = await Promise.all([
      this.repository.listUsers(input),
      breakdownPromise,
    ]);
    const usageByUser = new Map(
      (Array.isArray(breakdown?.users) ? breakdown.users : [])
        .map((item) => [number(item.user_id), this.mapUserUsage(item)]),
    );
    return {
      ...local,
      items: local.items.map((item) => ({
        ...item,
        ...(usageByUser.get(number(item.id)) || {}),
        id: number(item.id),
        email: item.email || usageByUser.get(number(item.id))?.email || '',
        username: item.username || '',
        cashPaidCny: number(item.cashPaidCny),
        creditedCny: number(item.creditedCny),
        adminCreditCny: number(item.adminCreditCny),
        adminDeductionCny: number(item.adminDeductionCny),
        redeemedCreditCny: number(item.redeemedCreditCny),
        affiliateCreditCny: number(item.affiliateCreditCny),
        balanceCny: number(item.balanceCny),
        excludeFromBalanceStats: Boolean(item.excludeFromBalanceStats),
      })),
    };
  }

  mapUsageEvent(item) {
    const totalTokens = number(item.input_tokens)
      + number(item.output_tokens)
      + number(item.cache_creation_tokens)
      + number(item.cache_read_tokens);
    const accountCost = item.account_stats_cost === null || item.account_stats_cost === undefined
      ? number(item.total_cost) * number(item.account_rate_multiplier || 1)
      : number(item.account_stats_cost) * number(item.account_rate_multiplier || 1);
    return {
      sourceUsageId: number(item.id),
      requestId: item.request_id || '',
      occurredAt: item.created_at,
      userId: number(item.user_id),
      email: item.user?.email || '',
      username: item.user?.username || '',
      accountId: number(item.account_id),
      accountName: item.account?.name || '',
      groupId: number(item.group_id),
      channelId: number(item.channel_id),
      model: item.model || '',
      requestedModel: item.requested_model || item.model || '',
      upstreamModel: item.upstream_model || '',
      billingMode: item.billing_mode || '',
      billingType: number(item.billing_type),
      inputTokens: number(item.input_tokens),
      outputTokens: number(item.output_tokens),
      cacheCreationTokens: number(item.cache_creation_tokens),
      cacheReadTokens: number(item.cache_read_tokens),
      totalTokens,
      tokens: totalTokens,
      durationMs: nullableNumber(item.duration_ms),
      firstTokenMs: nullableNumber(item.first_token_ms),
      standardCostUsdReference: number(item.total_cost),
      userChargeCny: number(item.actual_cost),
      recognizedRevenueCny: number(item.actual_cost),
      costMode: 'source_api',
      costStatus: 'source_api',
      calculatedCostCny: accountCost,
      bookedCostCny: accountCost,
      sourceSellingMultiplier: nullableNumber(item.rate_multiplier),
      upstreamMultiplier: nullableNumber(item.account_rate_multiplier),
      costSnapshotOrigin: 'source_api',
      costSnapshotFinalized: false,
    };
  }

  async listUsageEvents(input) {
    const payload = await this.gateway.listUsage({
      ...usageRange(input, this.config.timezone),
      page: input.page,
      pageSize: input.pageSize,
      requestId: input.search,
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return pageResult(
      items.map((item) => this.mapUsageEvent(item)),
      number(payload?.total),
      number(payload?.page) || input.page,
      number(payload?.page_size) || input.pageSize,
    );
  }

  async getUserDetails(input) {
    const [local, source, usage] = await Promise.all([
      this.repository.getUserDetails(input),
      this.sourceSnapshot(input, { userId: input.userId }),
      this.gateway.listUsage({
        ...usageRange(input, this.config.timezone),
        userId: input.userId,
        page: input.usage.page,
        pageSize: input.usage.pageSize,
      }),
    ]);
    const stats = summarizeModels(source);
    const trendByDay = new Map(
      (Array.isArray(source?.trend) ? source.trend : []).map((item) => [String(item.date), item]),
    );
    return {
      ...local,
      user: {
        ...local.user,
        consumptionCny: number(stats.total_actual_cost),
        requests: number(stats.total_requests),
        tokens: number(stats.total_tokens),
      },
      trend: local.trend.map((item) => ({
        ...item,
        consumptionCny: number(trendByDay.get(String(item.day))?.actual_cost),
      })),
      usage: pageResult(
        (Array.isArray(usage?.items) ? usage.items : []).map((item) => this.mapUsageEvent(item)),
        number(usage?.total),
        number(usage?.page) || input.usage.page,
        number(usage?.page_size) || input.usage.pageSize,
      ),
    };
  }

  accountRateSegments(input, account, timeline) {
    const days = listDayKeys(input.dailyStart, input.dailyEnd);
    if (!days.length) return [];
    const mode = String(account.costMode || account.costType || 'unconfigured');
    const rules = Array.isArray(timeline?.rules) ? timeline.rules : [];
    const observationsByKey = timeline?.observationsByKey instanceof Map
      ? timeline.observationsByKey
      : new Map();
    const defaultRate = nullableNumber(account.supplierKeyInventoryMultiplier)
      ?? nullableNumber(account.upstreamMultiplier);
    const segments = [];

    for (const day of days) {
      const matchingRules = rules.filter((rule) => {
        const startDay = zonedDayKey(rule.effectiveFrom, this.config.timezone);
        const endDay = rule.effectiveTo
          ? zonedDayKey(rule.effectiveTo, this.config.timezone)
          : '';
        return startDay <= day && (!endDay || endDay >= day);
      });
      const rule = matchingRules.sort((left, right) => (
        new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime()
        || number(right.id) - number(left.id)
      ))[0] || null;

      let kind = 'source_account_multiplier';
      let rate = null;
      let source = 'sub2api_account_multiplier';
      if (rule?.costMode === 'manual_multiplier') {
        rate = nullableNumber(rule.upstreamMultiplier);
        if (rate !== null && rate >= 0) {
          kind = 'multiplier';
          source = 'manual_rate_snapshot';
        }
      } else if (rule?.costMode === 'probe_multiplier') {
        const observations = observationsByKey.get(rule.supplierKeyId) || [];
        const observation = [...observations].reverse().find((item) => (
          zonedDayKey(item.observedAt, this.config.timezone) <= day
        ));
        rate = nullableNumber(observation?.rateMultiplier)
          ?? nullableNumber(rule.currentSupplierMultiplier)
          ?? defaultRate;
        if (rate !== null && rate >= 0) {
          kind = 'multiplier';
          source = 'supplier_rate_snapshot';
        }
      } else if (!rule && rules.length === 0 && ['manual_multiplier', 'probe_multiplier'].includes(mode)) {
        rate = defaultRate;
        if (rate !== null && rate >= 0) {
          kind = 'multiplier';
          source = mode === 'manual_multiplier'
            ? 'manual_rate_snapshot'
            : 'supplier_rate_snapshot';
        }
      }

      const key = `${kind}:${rate ?? ''}:${source}`;
      const previous = segments[segments.length - 1];
      if (previous?.key === key) {
        previous.endDate = day;
      } else {
        segments.push({
          key,
          startDate: day,
          endDate: day,
          kind,
          rate,
          source,
        });
      }
    }
    return segments;
  }

  async fetchAccountGroupStats(accountId, startDate, endDate) {
    const payload = await this.gateway.dashboardGroups({
      startDate,
      endDate,
      timezone: this.config.timezone,
      accountId,
    });
    return { ...summarizeGroups(payload), source_available: true };
  }

  emptySourceStats() {
    return {
      groups: [],
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      total_actual_cost: 0,
      total_account_cost: 0,
      selling_multiplier_min: null,
      selling_multiplier_max: null,
      account_multiplier_min: null,
      account_multiplier_max: null,
      source_available: true,
    };
  }

  dailyAccountStats(rows) {
    const byAccount = new Map();
    for (const row of rows || []) {
      const accountId = number(row.accountId);
      if (!byAccount.has(accountId)) byAccount.set(accountId, new Map());
      const byDay = byAccount.get(accountId);
      if (!byDay.has(row.day)) byDay.set(row.day, this.emptySourceStats());
      const stats = byDay.get(row.day);
      const cost = number(row.cost);
      const actualCost = number(row.actualCost);
      const accountCost = number(row.accountCost);
      const group = {
        groupId: number(row.groupId),
        groupName: '',
        requests: number(row.requests),
        totalTokens: number(row.totalTokens),
        cost,
        actualCost,
        accountCost,
        sellingMultiplier: cost > 0 ? actualCost / cost : null,
        accountMultiplier: cost > 0 ? accountCost / cost : null,
      };
      stats.groups.push(group);
      stats.total_requests += group.requests;
      stats.total_input_tokens += number(row.inputTokens);
      stats.total_output_tokens += number(row.outputTokens);
      stats.total_cache_tokens += number(row.cacheTokens);
      stats.total_tokens += group.totalTokens;
      stats.total_cost += cost;
      stats.total_actual_cost += actualCost;
      stats.total_account_cost += accountCost;
      for (const [field, value] of [
        ['selling_multiplier_min', group.sellingMultiplier],
        ['account_multiplier_min', group.accountMultiplier],
      ]) {
        if (value !== null) {
          stats[field] = stats[field] === null ? value : Math.min(stats[field], value);
        }
      }
      for (const [field, value] of [
        ['selling_multiplier_max', group.sellingMultiplier],
        ['account_multiplier_max', group.accountMultiplier],
      ]) {
        if (value !== null) {
          stats[field] = stats[field] === null ? value : Math.max(stats[field], value);
        }
      }
    }
    return byAccount;
  }

  accountStatsFromDaily(input, account, timeline, dailyStats = new Map()) {
    const dailyValues = [...dailyStats.values()];
    const stats = mergeAccountStats(dailyValues);
    stats.total_input_tokens = dailyValues
      .reduce((total, item) => total + number(item.total_input_tokens), 0);
    stats.total_output_tokens = dailyValues
      .reduce((total, item) => total + number(item.total_output_tokens), 0);
    stats.total_cache_tokens = dailyValues
      .reduce((total, item) => total + number(item.total_cache_tokens), 0);
    stats.source_available = true;
    const mode = String(account.costMode || account.costType || 'unconfigured');
    if (!['probe_multiplier', 'manual_multiplier'].includes(mode)) return stats;

    const segments = this.accountRateSegments(input, account, timeline);
    let multiplierCost = 0;
    const costsByDay = new Map();
    const sources = new Set();
    const upstreamRates = [];
    for (const segment of segments) {
      sources.add(segment.source);
      if (segment.kind === 'multiplier') upstreamRates.push(number(segment.rate));
      for (const day of listDayKeys(segment.startDate, segment.endDate)) {
        const dayStats = dailyStats.get(day) || this.emptySourceStats();
        const cost = segment.kind === 'multiplier'
          ? groupMultiplierCost(dayStats.groups, segment.rate)
          : number(dayStats.total_account_cost);
        multiplierCost += cost;
        costsByDay.set(day, cost);
      }
    }
    stats.calculated_multiplier_cost_cny = multiplierCost;
    stats.calculated_multiplier_cost_by_day = costsByDay;
    stats.multiplier_cost_source = sources.size === 1
      ? [...sources][0]
      : 'mixed_rate_snapshots';
    stats.upstream_multiplier_min = upstreamRates.length ? Math.min(...upstreamRates) : null;
    stats.upstream_multiplier_max = upstreamRates.length ? Math.max(...upstreamRates) : null;
    return stats;
  }

  calculateOperatingCost(account, stats) {
    const mode = String(account.costMode || account.costType || 'unconfigured');
    if (mode === 'fixed_purchase') {
      return account.hasCostRecord || number(account.fixedAcquisitionCostCny) > 0
        ? { cost: 0, costKnown: true }
        : { cost: null, costKnown: false };
    }
    if (mode === 'free') return { cost: 0, costKnown: true };
    if (['probe_multiplier', 'manual_multiplier'].includes(mode)) {
      const cost = nullableNumber(stats.calculated_multiplier_cost_cny);
      return cost === null ? { cost: null, costKnown: false } : { cost, costKnown: true };
    }
    return stats.source_available
      ? { cost: number(stats.total_account_cost), costKnown: true }
      : { cost: null, costKnown: false };
  }

  async getSourceEconomics(input) {
    if (!this.sourceUsageRepository) {
      const stats = summarizeModels(await this.sourceSnapshot(input));
      return {
        ...stats,
        calculated_cost_cny: stats.total_account_cost,
        active_accounts: 0,
        missing_cost_count: 0,
        unpriced_actual_cost: 0,
        by_day: new Map(),
      };
    }
    const rows = await this.sourceUsageRepository.getDailyAccountGroupStats({
      start: input.start,
      end: input.end,
    });
    const dailyByAccount = this.dailyAccountStats(rows);
    const accountIds = [...dailyByAccount.keys()].filter((id) => id > 0);
    const [accounts, timelines] = await Promise.all([
      this.repository.getAccountCostingProfiles({ accountIds }),
      this.repository.getAccountCostRateTimelines({
        accountIds,
        start: input.start,
        end: input.end,
      }),
    ]);
    const accountsById = new Map(accounts.map((account) => [number(account.id), account]));
    const summary = this.emptySourceStats();
    summary.calculated_cost_cny = 0;
    summary.unpriced_actual_cost = 0;
    summary.missing_cost_count = 0;
    summary.active_accounts = 0;
    summary.by_day = new Map();

    for (const [accountId, byDay] of dailyByAccount) {
      const account = accountsById.get(accountId) || {
        id: accountId,
        costMode: 'unconfigured',
        costType: 'unconfigured',
      };
      const stats = this.accountStatsFromDaily(
        input,
        account,
        timelines.get(accountId),
        byDay,
      );
      const calculated = this.calculateOperatingCost(account, stats);
      summary.active_accounts += 1;
      summary.total_requests += number(stats.total_requests);
      summary.total_input_tokens += number(stats.total_input_tokens);
      summary.total_output_tokens += number(stats.total_output_tokens);
      summary.total_cache_tokens += number(stats.total_cache_tokens);
      summary.total_tokens += number(stats.total_tokens);
      summary.total_cost += number(stats.total_cost);
      summary.total_actual_cost += number(stats.total_actual_cost);
      summary.total_account_cost += number(stats.total_account_cost);
      if (calculated.costKnown) summary.calculated_cost_cny += number(calculated.cost);
      else {
        summary.missing_cost_count += 1;
        summary.unpriced_actual_cost += number(stats.total_actual_cost);
      }

      for (const [day, dayStats] of byDay) {
        const point = summary.by_day.get(day) || {
          total_requests: 0,
          total_tokens: 0,
          total_cost: 0,
          total_actual_cost: 0,
          total_account_cost: 0,
          calculated_cost_cny: 0,
        };
        const dayCost = ['probe_multiplier', 'manual_multiplier']
          .includes(String(account.costMode || account.costType))
          ? number(stats.calculated_multiplier_cost_by_day?.get(day))
          : number(this.calculateOperatingCost(account, dayStats).cost);
        point.total_requests += number(dayStats.total_requests);
        point.total_tokens += number(dayStats.total_tokens);
        point.total_cost += number(dayStats.total_cost);
        point.total_actual_cost += number(dayStats.total_actual_cost);
        point.total_account_cost += number(dayStats.total_account_cost);
        point.calculated_cost_cny += dayCost;
        summary.by_day.set(day, point);
      }
    }
    return summary;
  }

  calculateAccountCost(account, stats) {
    const mode = String(account.costMode || account.costType || 'unconfigured');
    const fixedCost = number(account.fixedAcquisitionCostCny);
    if (mode === 'fixed_purchase') {
      const hasFixedCost = Boolean(
        account.hasCostRecord
        || account.currentCostPeriodId
        || fixedCost > 0,
      );
      return hasFixedCost
        ? {
          cost: fixedCost,
          fixedCost,
          multiplierCost: 0,
          costKnown: true,
          source: 'fixed_purchase',
        }
        : { cost: null, fixedCost: null, multiplierCost: null, costKnown: false };
    }
    if (mode === 'free') {
      return {
        cost: 0,
        fixedCost: 0,
        multiplierCost: 0,
        costKnown: true,
        source: 'free',
      };
    }
    if (['probe_multiplier', 'manual_multiplier'].includes(mode)) {
      const multiplierCost = nullableNumber(stats.calculated_multiplier_cost_cny);
      if (multiplierCost === null) {
        return { cost: null, fixedCost: 0, multiplierCost: null, costKnown: false };
      }
      return {
        cost: multiplierCost,
        fixedCost: 0,
        multiplierCost,
        costKnown: true,
        source: stats.multiplier_cost_source || (
          mode === 'manual_multiplier' ? 'manual_rate_snapshot' : 'supplier_rate_snapshot'
        ),
      };
    }
    if (!stats.source_available) {
      return {
        cost: null,
        fixedCost: null,
        multiplierCost: null,
        costKnown: false,
      };
    }
    return {
      cost: number(stats.total_account_cost),
      fixedCost: 0,
      multiplierCost: number(stats.total_account_cost),
      costKnown: true,
      source: 'sub2api_account_multiplier',
    };
  }

  enrichAccount(account, stats) {
    const revenue = number(stats.total_actual_cost);
    const calculated = this.calculateAccountCost(account, stats);
    const requests = number(stats.total_requests);
    const mode = String(account.costMode || account.costType || 'unconfigured');
    const missing = !calculated.costKnown;
    return {
      ...account,
      acquisitionCostCny: calculated.cost,
      accountCostCny: calculated.cost,
      fixedAcquisitionCostCny: calculated.fixedCost,
      multiplierCostCny: calculated.multiplierCost,
      periodCost: calculated.cost,
      periodCostCny: calculated.cost,
      purchaseAllocatedCostCny: calculated.fixedCost,
      tokenListValueUsd: number(stats.total_cost),
      requests,
      tokens: number(stats.total_tokens),
      costCoverageStatus: missing ? 'missing' : requests ? 'complete' : 'configured',
      hasCostRecord: calculated.costKnown,
      pricedUserChargeCny: missing ? 0 : revenue,
      unpricedUserChargeCny: missing ? revenue : 0,
      pricedUsageCount: missing ? 0 : requests,
      unpricedUsageCount: missing ? requests : 0,
      periodUpstreamMultiplierMin: nullableNumber(stats.upstream_multiplier_min),
      periodUpstreamMultiplierMax: nullableNumber(stats.upstream_multiplier_max),
      periodSellingMultiplierMin: nullableNumber(stats.selling_multiplier_min),
      periodSellingMultiplierMax: nullableNumber(stats.selling_multiplier_max),
      sourceAccountMultiplierMin: nullableNumber(stats.account_multiplier_min),
      sourceAccountMultiplierMax: nullableNumber(stats.account_multiplier_max),
      multiplierCostSource: calculated.source || '',
      ...financialFields(revenue, calculated.cost),
    };
  }

  async accountStats(input, account, timeline) {
    const accountId = number(account.id);
    const mode = String(account.costMode || account.costType || 'unconfigured');
    if (!['probe_multiplier', 'manual_multiplier'].includes(mode)) {
      return this.fetchAccountGroupStats(accountId, input.dailyStart, input.dailyEnd);
    }

    const segments = this.accountRateSegments(input, account, timeline);
    const loaded = await Promise.all(segments.map(async (segment) => ({
      ...segment,
      stats: await this.fetchAccountGroupStats(accountId, segment.startDate, segment.endDate),
    })));
    const stats = mergeAccountStats(loaded.map((item) => item.stats));
    let multiplierCost = 0;
    const sources = new Set();
    const upstreamRates = [];
    for (const segment of loaded) {
      sources.add(segment.source);
      if (segment.kind === 'multiplier') {
        multiplierCost += groupMultiplierCost(segment.stats.groups, segment.rate);
        upstreamRates.push(number(segment.rate));
      } else {
        multiplierCost += number(segment.stats.total_account_cost);
      }
    }
    stats.calculated_multiplier_cost_cny = multiplierCost;
    stats.multiplier_cost_source = sources.size === 1
      ? [...sources][0]
      : 'mixed_rate_snapshots';
    stats.upstream_multiplier_min = upstreamRates.length ? Math.min(...upstreamRates) : null;
    stats.upstream_multiplier_max = upstreamRates.length ? Math.max(...upstreamRates) : null;
    stats.source_available = loaded.length > 0 && loaded.every((item) => item.stats.source_available);
    return stats;
  }

  accountSummary(items, total, partialUsageSummary = false) {
    const summary = items.reduce((result, item) => {
      result.userChargeCny += number(item.userChargeCny);
      result.requests += number(item.requests);
      result.unpricedUserChargeCny += number(item.unpricedUserChargeCny);
      if (['missing', 'partial'].includes(String(item.costCoverageStatus))) {
        result.missingCostCount += 1;
      } else {
        result.accountCostCny += number(item.accountCostCny);
        result.fixedAcquisitionCostCny += number(item.fixedAcquisitionCostCny);
        result.multiplierCostCny += number(item.multiplierCostCny);
        result.pricedUserChargeCny += number(item.userChargeCny);
        result.profitCny += number(item.profitCny);
        result.pricedAccountCount += 1;
      }
      return result;
    }, {
      accountCount: total,
      summarizedAccountCount: items.length,
      pricedAccountCount: 0,
      acquisitionCostCny: 0,
      accountCostCny: 0,
      fixedAcquisitionCostCny: 0,
      multiplierCostCny: 0,
      userChargeCny: 0,
      pricedUserChargeCny: 0,
      unpricedUserChargeCny: 0,
      profitCny: 0,
      requests: 0,
      missingCostCount: 0,
      partialUsageSummary,
    });
    summary.acquisitionCostCny = summary.accountCostCny;
    summary.costCoverageStatus = summary.missingCostCount ? 'partial' : 'complete';
    return summary;
  }

  async listAccounts(input) {
    const first = await this.repository.listAccounts(input);
    let targetItems = first.items;
    if (first.total > first.items.length) {
      const all = await this.repository.listAccounts({
        ...input,
        page: 1,
        pageSize: first.total,
        offset: 0,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      targetItems = all.items;
    }
    const accountIds = targetItems.map((account) => number(account.id));
    let timelines;
    let sourceRows;
    try {
      [timelines, sourceRows] = await Promise.all([
        this.repository.getAccountCostRateTimelines({
          accountIds,
          start: input.start,
          end: input.end,
        }),
        this.sourceUsageRepository.getDailyAccountGroupStats({
          start: input.start,
          end: input.end,
          accountIds,
        }),
      ]);
    } catch (error) {
      this.logger.warn('[source usage] account batch aggregate failed', error?.message || error);
      throw error;
    }
    const dailyByAccount = this.dailyAccountStats(sourceRows);
    const enriched = targetItems.map((account) => this.enrichAccount(
      account,
      this.accountStatsFromDaily(
        input,
        account,
        timelines.get(number(account.id)),
        dailyByAccount.get(number(account.id)),
      ),
    ));
    const byId = new Map(enriched.map((item) => [number(item.id), item]));
    let visible = first.items.map((item) => byId.get(number(item.id)) || item);
    const sortField = {
      acquisitionCostCny: 'accountCostCny',
      userChargeCny: 'userChargeCny',
      profitCny: 'profitCny',
      requests: 'requests',
      tokens: 'tokens',
    }[input.sortBy];
    if (sortField) {
      const sorted = [...enriched].sort(compare(sortField, input.sortOrder));
      visible = sorted.slice(input.offset, input.offset + input.pageSize);
    }
    return {
      ...first,
      items: visible,
      summary: this.accountSummary(enriched, first.total, false),
    };
  }

  async getSupplierOverview(input) {
    const fanoutLimit = this.config.sub2apiUsageAccountFanoutLimit || 20;
    const [local, accounts] = await Promise.all([
      this.repository.getSupplierOverview(input),
      this.listAccounts({
        ...input,
        page: 1,
        pageSize: fanoutLimit,
        offset: 0,
        scope: 'current',
        search: input.search || '',
        platform: '',
        accountType: '',
        supplier: '',
        status: '',
        privacyMode: '',
        accountIds: null,
        costMode: '',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
    ]);
    const bySupplier = new Map();
    for (const account of accounts.items) {
      const supplier = account.supplier || '未标记供应商';
      const bucket = bySupplier.get(supplier) || {
        requests: 0,
        tokens: 0,
        userChargeCny: 0,
        effectiveCostCny: 0,
        multiplierCostCny: 0,
      };
      bucket.requests += number(account.requests);
      bucket.tokens += number(account.tokens);
      bucket.userChargeCny += number(account.userChargeCny);
      bucket.effectiveCostCny += number(account.effectiveCostCny);
      bucket.multiplierCostCny += number(account.multiplierCostCny);
      bySupplier.set(supplier, bucket);
    }
    const items = local.items.map((item) => {
      const usage = bySupplier.get(item.supplier) || {};
      const revenue = number(usage.userChargeCny);
      const fixedCost = number(item.purchaseAllocatedCostCny);
      const multiplierCost = number(usage.multiplierCostCny);
      const cost = fixedCost + multiplierCost;
      return {
        ...item,
        requests: number(usage.requests),
        tokens: number(usage.tokens),
        purchaseSpend: fixedCost,
        purchaseAllocatedCostCny: fixedCost,
        multiplierCostCny: multiplierCost,
        ...financialFields(revenue, cost),
      };
    });
    const summary = items.reduce((result, item) => {
      result.supplierCount += 1;
      result.accountCount += number(item.accountCount);
      result.purchaseSpend += number(item.purchaseSpend);
      result.revenue += number(item.revenue);
      result.recognizedRevenueCny += number(item.recognizedRevenueCny);
      result.userChargeCny += number(item.userChargeCny);
      result.effectiveCostCny += number(item.effectiveCostCny);
      result.grossProfit += number(item.grossProfit);
      result.unbookedAccountCount += number(item.unbookedAccountCount);
      result.costConflictCount += number(item.costConflictCount);
      result.missingSupplierAccounts += item.supplier === '未标记供应商' ? number(item.accountCount) : 0;
      return result;
    }, {
      supplierCount: 0,
      accountCount: 0,
      purchaseSpend: 0,
      revenue: 0,
      recognizedRevenueCny: 0,
      userChargeCny: 0,
      effectiveCostCny: 0,
      unbookedAccountCount: 0,
      costConflictCount: 0,
      grossProfit: 0,
      missingSupplierAccounts: 0,
      partialUsageSummary: Boolean(accounts.summary?.partialUsageSummary),
      summarizedAccountCount: number(accounts.summary?.summarizedAccountCount),
    });
    return { ...local, items, summary };
  }
}
