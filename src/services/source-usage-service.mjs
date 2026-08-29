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

function financialFields(revenue, cost, unpricedRevenue = 0) {
  const normalizedRevenue = number(revenue);
  const normalizedCost = nullableNumber(cost);
  const normalizedUnpricedRevenue = Math.max(
    0,
    Math.min(normalizedRevenue, number(unpricedRevenue)),
  );
  const pricedRevenue = normalizedRevenue - normalizedUnpricedRevenue;
  if (normalizedCost === null) {
    return {
      revenue: normalizedRevenue,
      revenueCny: normalizedRevenue,
      recognizedRevenueCny: normalizedRevenue,
      userChargeCny: normalizedRevenue,
      pricedUserChargeCny: 0,
      unpricedUserChargeCny: normalizedRevenue,
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
  const profit = pricedRevenue - normalizedCost;
  return {
    revenue: normalizedRevenue,
    revenueCny: normalizedRevenue,
    recognizedRevenueCny: normalizedRevenue,
    userChargeCny: normalizedRevenue,
    pricedUserChargeCny: pricedRevenue,
    unpricedUserChargeCny: normalizedUnpricedRevenue,
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
    margin: pricedRevenue ? profit / pricedRevenue : null,
    grossMargin: pricedRevenue ? profit / pricedRevenue : null,
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
    return summary;
  }, {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    total_actual_cost: 0,
  });
}

function summarizeGroups(payload) {
  const groups = (Array.isArray(payload?.groups) ? payload.groups : []).map((item) => {
    const cost = number(item.cost);
    const actualCost = number(item.actual_cost);
    return {
      groupId: number(item.group_id),
      groupName: item.group_name || '',
      requests: number(item.requests),
      totalTokens: number(item.total_tokens),
      cost,
      actualCost,
      sellingMultiplier: cost > 0 ? actualCost / cost : null,
    };
  });
  return groups.reduce((summary, group) => {
    summary.total_requests += group.requests;
    summary.total_tokens += group.totalTokens;
    summary.total_cost += group.cost;
    summary.total_actual_cost += group.actualCost;
    if (group.sellingMultiplier !== null) {
      summary.selling_multiplier_min = summary.selling_multiplier_min === null
        ? group.sellingMultiplier
        : Math.min(summary.selling_multiplier_min, group.sellingMultiplier);
      summary.selling_multiplier_max = summary.selling_multiplier_max === null
        ? group.sellingMultiplier
        : Math.max(summary.selling_multiplier_max, group.sellingMultiplier);
    }
    return summary;
  }, {
    groups,
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
    total_actual_cost: 0,
    selling_multiplier_min: null,
    selling_multiplier_max: null,
  });
}

function mergeAccountStats(items) {
  return items.reduce((summary, item) => {
    summary.groups.push(...(item.groups || []));
    summary.total_requests += number(item.total_requests);
    summary.total_tokens += number(item.total_tokens);
    summary.total_cost += number(item.total_cost);
    summary.total_actual_cost += number(item.total_actual_cost);
    for (const field of ['selling_multiplier_min']) {
      const value = nullableNumber(item[field]);
      if (value !== null) summary[field] = summary[field] === null ? value : Math.min(summary[field], value);
    }
    for (const field of ['selling_multiplier_max']) {
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
    selling_multiplier_min: null,
    selling_multiplier_max: null,
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

function calculateMultiplierCost(referenceCost, upstreamMultiplier) {
  const upstream = nullableNumber(upstreamMultiplier);
  if (upstream === null || upstream < 0) return null;
  return number(referenceCost) * upstream;
}

function costFromPricing(referenceCost, pricing) {
  if (!pricing?.known) return null;
  return pricing.rate === undefined
    ? 0
    : calculateMultiplierCost(referenceCost, pricing.rate);
}

function dimensionSortField(sort) {
  return {
    userChargeCny: 'userChargeCny',
    requests: 'requests',
    tokens: 'tokens',
    bookedCostCny: 'bookedCostCny',
    bookedProfitCny: 'bookedProfitCny',
  }[sort] || 'userChargeCny';
}

function sortAndPage(items, input) {
  const sorted = [...items].sort(compare(
    dimensionSortField(input.sort),
    input.direction,
  ));
  return pageResult(
    sorted.slice(input.offset, input.offset + input.pageSize),
    sorted.length,
    input.page,
    input.pageSize,
  );
}

function summarizeUserFinance(items) {
  const included = items.filter((item) => !item.excludeFromBalanceStats);
  const summary = included.reduce((result, item) => {
    const balance = number(item.balanceCny);
    const cashPaid = number(item.cashPaidCny);
    result.remainingBalanceCny += Math.max(0, balance);
    result.positiveBalanceUserCount += balance > 0 ? 1 : 0;
    result.cashPaidCny += cashPaid;
    result.cashPayingUserCount += cashPaid > 0 ? 1 : 0;
    result.userChargeCny += number(item.userChargeCny);
    result.requests += number(item.requests);
    result.bookedCostCny += number(item.bookedCostCny ?? item.effectiveCostCny);
    result.bookedProfitCny += number(item.bookedProfitCny ?? item.grossProfitCny);
    result.partialCostUserCount += item.costCoverageStatus === 'complete' ? 0 : 1;
    return result;
  }, {
    userCount: included.length,
    excludedUserCount: items.length - included.length,
    remainingBalanceCny: 0,
    positiveBalanceUserCount: 0,
    cashPaidCny: 0,
    cashPayingUserCount: 0,
    userChargeCny: 0,
    requests: 0,
    bookedCostCny: 0,
    bookedProfitCny: 0,
    partialCostUserCount: 0,
    grossMargin: null,
  });
  summary.grossMargin = summary.userChargeCny
    ? summary.bookedProfitCny / summary.userChargeCny
    : null;
  return summary;
}

function filterUserFinanceItems(items, scope = 'all') {
  if (scope === 'all') return items;
  return items.filter((item) => {
    if (item.excludeFromBalanceStats) return false;
    const balance = number(item.balanceCny);
    const cashPaid = number(item.cashPaidCny);
    const charge = number(item.userChargeCny);
    const cost = number(item.bookedCostCny ?? item.effectiveCostCny);
    const profit = number(item.bookedProfitCny ?? item.grossProfitCny);
    if (scope === 'included') return true;
    if (scope === 'balance') return balance > 0;
    if (scope === 'cash') return cashPaid > 0;
    if (scope === 'consumption') return charge > 0;
    if (scope === 'cost') return cost !== 0 || item.costCoverageStatus !== 'complete';
    if (scope === 'profit') return profit !== 0 || charge !== 0 || cost !== 0;
    return true;
  });
}

export class SourceUsageService {
  constructor(repository, gateway, config, sourceUsageRepository = null, logger = console) {
    this.repository = repository;
    this.gateway = gateway;
    this.config = config;
    this.sourceUsageRepository = sourceUsageRepository;
    this.logger = logger;
    this.sourceEconomicsInflight = new Map();
    this.dashboardUsageInflight = new Map();
  }

  usageRangeKey(input) {
    return `${new Date(input.start).toISOString()}:${new Date(input.end).toISOString()}`;
  }

  async getDashboardUsageRows(input) {
    const key = this.usageRangeKey(input);
    if (this.dashboardUsageInflight.has(key)) return this.dashboardUsageInflight.get(key);

    const load = (async () => {
      if (typeof this.sourceUsageRepository.getDailyAccountAndModelStats === 'function') {
        const result = await this.sourceUsageRepository.getDailyAccountAndModelStats({
          start: input.start,
          end: input.end,
        });
        return {
          accounts: Array.isArray(result?.accounts) ? result.accounts : [],
          models: Array.isArray(result?.models) ? result.models : [],
        };
      }
      const [accounts, models] = await Promise.all([
        this.sourceUsageRepository.getDailyAccountGroupStats({
          start: input.start,
          end: input.end,
        }),
        this.sourceUsageRepository.getDailyDimensionStats({
          start: input.start,
          end: input.end,
          dimension: 'model',
        }),
      ]);
      return { accounts, models };
    })().finally(() => this.dashboardUsageInflight.delete(key));

    this.dashboardUsageInflight.set(key, load);
    return load;
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
    const unpricedRevenue = number(source.unpriced_actual_cost);
    const pricedRevenue = Math.max(0, revenue - unpricedRevenue);
    const registeredProcurementCost = number(local.operations?.purchaseAllocatedCostCny);
    const effectiveCost = registeredProcurementCost + multiplierCost;
    const profit = pricedRevenue - effectiveCost;
    return {
      ...local,
      operations: {
        ...local.operations,
        consumptionCny: revenue,
        revenue,
        revenueCny: revenue,
        recognizedRevenueCny: revenue,
        userChargeCny: revenue,
        pricedUserChargeCny: pricedRevenue,
        tokenListValueUsd: number(source.total_cost),
        purchaseAllocatedCostCny: registeredProcurementCost,
        allocatedCost: registeredProcurementCost,
        allocatedCostCny: registeredProcurementCost,
        registeredProcurementCostCny: registeredProcurementCost,
        multiplierCostCny: multiplierCost,
        effectiveCostCny: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        grossProfit: profit,
        grossProfitCny: profit,
        bookedProfitCny: profit,
        grossMargin: pricedRevenue ? profit / pricedRevenue : null,
        unbookedAccountCount: number(source.missing_cost_count),
        unbookedRevenueCny: unpricedRevenue,
        unbookedUserChargeCny: unpricedRevenue,
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
        const unpricedRevenue = number(point.unpriced_actual_cost);
        const registeredProcurementCost = number(localPoint.purchaseAllocatedCostCny);
        const cost = sourceCost + registeredProcurementCost;
        return {
          day,
          ...financialFields(revenue, cost, unpricedRevenue),
          missingCostCount: number(point.missing_cost_count),
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
    if (this.sourceUsageRepository) {
      let items = await this.getDimensionEconomics(input, 'model');
      if (input.search) {
        const term = String(input.search).toLowerCase();
        items = items.filter((item) => String(item.name || '').toLowerCase().includes(term));
      }
      return sortAndPage(items, input);
    }
    const source = await this.sourceSnapshot(input);
    let items = (Array.isArray(source?.models) ? source.models : []).map((item) => {
      const revenue = number(item.actual_cost);
      const cost = null;
      return {
        name: String(item.model || '').trim() || '未标注模型',
        requests: number(item.requests),
        tokens: number(item.total_tokens),
        tokenListValueUsd: number(item.cost),
        purchaseAllocatedCostCny: 0,
        multiplierCostCny: cost,
        unbookedAccountCount: 0,
        costCoverageStatus: 'missing',
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
    const cost = null;
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
      costCoverageStatus: revenue > 0 ? 'missing' : 'configured',
      ...financialFields(revenue, cost),
    };
  }

  async listUsers(input) {
    if (this.sourceUsageRepository) {
      const usageItems = await this.getDimensionEconomics(input, 'user');
      const term = String(input.search || '').toLowerCase();
      if (input.consumptionOnly) {
        const items = term
          ? usageItems.filter((item) => `${item.id} ${item.email} ${item.name}`
            .toLowerCase().includes(term))
          : usageItems;
        return sortAndPage(items, input);
      }

      const localFirst = await this.repository.listUsers({
        ...input,
        page: 1,
        pageSize: Math.max(100, number(input.pageSize)),
        offset: 0,
        consumptionOnly: false,
      });
      const local = localFirst.total > localFirst.items.length
        ? await this.repository.listUsers({
          ...input,
          page: 1,
          pageSize: localFirst.total,
          offset: 0,
          consumptionOnly: false,
        })
        : localFirst;
      const usageByUser = new Map(usageItems.map((item) => [number(item.id), item]));
      const zeroUsage = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        tokens: 0,
        tokenListValueUsd: 0,
        purchaseAllocatedCostCny: 0,
        multiplierCostCny: 0,
        unbookedAccountCount: 0,
        unbookedUserChargeCny: 0,
        costCoverageStatus: 'configured',
        ...financialFields(0, 0),
      };
      const usedIds = new Set();
      const items = local.items.map((item) => {
        const id = number(item.id);
        const usage = usageByUser.get(id);
        usedIds.add(id);
        return {
          ...zeroUsage,
          ...item,
          ...usage,
          id,
          email: item.email || usage?.email || '',
          username: item.username || '',
          cashPaidCny: number(item.cashPaidCny),
          creditedCny: number(item.creditedCny),
          adminCreditCny: number(item.adminCreditCny),
          adminDeductionCny: number(item.adminDeductionCny),
          redeemedCreditCny: number(item.redeemedCreditCny),
          affiliateCreditCny: number(item.affiliateCreditCny),
          balanceCny: number(item.balanceCny),
          excludeFromBalanceStats: Boolean(item.excludeFromBalanceStats),
        };
      });
      if ((input.balanceScope || 'all') === 'all') {
        for (const usage of usageItems) {
          if (!usedIds.has(number(usage.id))) {
            items.push({
              ...zeroUsage,
              ...usage,
              id: number(usage.id),
              email: usage.email || '',
              username: '',
              cashPaidCny: 0,
              creditedCny: 0,
              adminCreditCny: 0,
              adminDeductionCny: 0,
              redeemedCreditCny: 0,
              affiliateCreditCny: 0,
              balanceCny: 0,
              excludeFromBalanceStats: false,
            });
          }
        }
      }
      const searched = term
        ? items.filter((item) => `${item.id} ${item.email} ${item.username}`
          .toLowerCase().includes(term))
        : items;
      const filtered = filterUserFinanceItems(searched, input.financeScope);
      return {
        ...sortAndPage(filtered, input),
        summary: summarizeUserFinance(filtered),
      };
    }
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
      summary: local.summary || summarizeUserFinance(local.items),
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

  async accountPricingContext(input, accountIds) {
    const ids = [...new Set((accountIds || [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0))];
    const [accounts, timelines] = await Promise.all([
      this.repository.getAccountCostingProfiles({
        accountIds: ids,
        start: input.start,
        end: input.end,
      }),
      this.repository.getAccountCostRateTimelines({
        accountIds: ids,
        start: input.start,
        end: input.end,
      }),
    ]);
    const accountsById = new Map(accounts.map((account) => [number(account.id), account]));
    const pricingByAccount = new Map();
    for (const accountId of ids) {
      const account = accountsById.get(accountId) || {
        id: accountId,
        costMode: 'unconfigured',
        costType: 'unconfigured',
      };
      accountsById.set(accountId, account);
      pricingByAccount.set(accountId, this.accountDayPricing(
        input,
        account,
        timelines.get(accountId),
      ));
    }
    return { accountsById, pricingByAccount };
  }

  mapUsageEvent(item, pricingContext = null) {
    const totalTokens = number(item.input_tokens)
      + number(item.output_tokens)
      + number(item.cache_creation_tokens)
      + number(item.cache_read_tokens);
    const accountId = number(item.account_id);
    const account = pricingContext?.accountsById?.get(accountId) || {
      costMode: 'unconfigured',
      costType: 'unconfigured',
    };
    const costMode = String(account.costMode || account.costType || 'unconfigured');
    const day = zonedDayKey(item.created_at, this.config.timezone);
    const pricing = pricingContext?.pricingByAccount?.get(accountId)?.get(day);
    const calculatedCost = costFromPricing(item.total_cost, pricing);
    const costStatus = costMode === 'free'
      ? 'free'
      : costMode === 'fixed_purchase'
        ? 'fixed_cost'
        : pricing?.known
          ? 'priced'
          : 'missing';
    return {
      sourceUsageId: number(item.id),
      requestId: item.request_id || '',
      occurredAt: item.created_at,
      userId: number(item.user_id),
      email: item.user?.email || '',
      username: item.user?.username || '',
      accountId,
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
      costMode,
      costStatus,
      calculatedCostCny: calculatedCost,
      bookedCostCny: calculatedCost,
      sourceSellingMultiplier: nullableNumber(item.rate_multiplier),
      upstreamMultiplier: nullableNumber(pricing?.rate),
      costSnapshotOrigin: pricing?.source || 'missing_finops_cost',
      costSnapshotFinalized: pricing?.known || false,
    };
  }

  async listUsageEvents(input) {
    const payload = await this.gateway.listUsage({
      ...usageRange(input, this.config.timezone),
      page: input.page,
      pageSize: input.pageSize,
      userId: input.userId,
      requestId: input.search,
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const pricingContext = await this.accountPricingContext(
      input,
      items.map((item) => item.account_id),
    );
    return pageResult(
      items.map((item) => this.mapUsageEvent(item, pricingContext)),
      number(payload?.total),
      number(payload?.page) || input.page,
      number(payload?.page_size) || input.pageSize,
    );
  }

  async getUserDetails(input) {
    const [local, source, usage] = await Promise.all([
      this.repository.getUserDetails(input),
      this.sourceSnapshot(input, { userId: input.userId }),
      this.listUsageEvents({
        ...input,
        userId: input.userId,
        page: input.usage.page,
        pageSize: input.usage.pageSize,
        offset: (input.usage.page - 1) * input.usage.pageSize,
        search: '',
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
        Array.isArray(usage?.items) ? usage.items : [],
        number(usage?.total),
        number(usage?.page) || input.usage.page,
        number(usage?.pageSize) || input.usage.pageSize,
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

      let kind = 'missing_finops_rate';
      let rate = null;
      let source = 'missing_finops_rate';
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

  accountDayPricing(input, account, timeline) {
    const days = listDayKeys(input.dailyStart, input.dailyEnd);
    const mode = String(account.costMode || account.costType || 'unconfigured');
    const pricing = new Map();
    if (mode === 'free') {
      for (const day of days) pricing.set(day, {
        known: true,
        cost: 0,
        source: 'free',
      });
      return pricing;
    }
    if (mode === 'fixed_purchase') {
      // Fixed procurement is recognized in the account ledger once. It must
      // not be duplicated across model, user, or request dimensions.
      for (const day of days) pricing.set(day, {
        known: false,
        cost: null,
        source: 'fixed_purchase_account_level',
      });
      return pricing;
    }
    if (!['probe_multiplier', 'manual_multiplier'].includes(mode)) {
      for (const day of days) pricing.set(day, {
        known: false,
        cost: null,
        source: 'missing_finops_cost',
      });
      return pricing;
    }
    for (const segment of this.accountRateSegments(input, account, timeline)) {
      for (const day of listDayKeys(segment.startDate, segment.endDate)) {
        pricing.set(day, segment.kind === 'multiplier'
          ? {
            known: true,
            rate: number(segment.rate),
            source: segment.source,
          }
          : {
            known: false,
            cost: null,
            source: segment.source,
          });
      }
    }
    return pricing;
  }

  async getDimensionEconomics(input, dimension) {
    const rows = dimension === 'model'
      ? (await this.getDashboardUsageRows(input)).models
      : await this.sourceUsageRepository.getDailyDimensionStats({
        start: input.start,
        end: input.end,
        dimension,
      });
    const accountIds = [...new Set(rows.map((row) => number(row.accountId)).filter((id) => id > 0))];
    const [accounts, timelines] = await Promise.all([
      this.repository.getAccountCostingProfiles({
        accountIds,
        start: input.start,
        end: input.end,
      }),
      this.repository.getAccountCostRateTimelines({
        accountIds,
        start: input.start,
        end: input.end,
      }),
    ]);
    const accountsById = new Map(accounts.map((account) => [number(account.id), account]));
    const pricingByAccount = new Map();
    for (const accountId of accountIds) {
      const account = accountsById.get(accountId) || {
        id: accountId,
        costMode: 'unconfigured',
        costType: 'unconfigured',
      };
      pricingByAccount.set(accountId, this.accountDayPricing(
        input,
        account,
        timelines.get(accountId),
      ));
    }
    const buckets = new Map();
    for (const row of rows) {
      const key = String(row.dimensionKey);
      const bucket = buckets.get(key) || {
        id: dimension === 'user' ? number(row.dimensionKey) : undefined,
        name: row.dimensionName || '',
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        tokens: 0,
        tokenListValueUsd: 0,
        revenue: 0,
        knownCost: 0,
        hasKnownCost: false,
        unpricedRevenue: 0,
        missingAccounts: new Set(),
      };
      bucket.name ||= row.dimensionName || '';
      bucket.requests += number(row.requests);
      bucket.inputTokens += number(row.inputTokens);
      bucket.outputTokens += number(row.outputTokens);
      bucket.cacheTokens += number(row.cacheTokens);
      bucket.tokens += number(row.totalTokens);
      bucket.tokenListValueUsd += number(row.cost);
      bucket.revenue += number(row.actualCost);
      const pricing = pricingByAccount.get(number(row.accountId))?.get(row.day);
      if (pricing?.known) {
        bucket.knownCost += number(calculateMultiplierCost(row.cost, pricing.rate));
        bucket.hasKnownCost = true;
      } else {
        bucket.unpricedRevenue += number(row.actualCost);
        bucket.missingAccounts.add(number(row.accountId));
      }
      buckets.set(key, bucket);
    }
    return [...buckets.values()].map((bucket) => {
      const cost = bucket.hasKnownCost ? bucket.knownCost : null;
      const status = bucket.unpricedRevenue > 0
        ? (cost === null ? 'missing' : 'partial')
        : 'complete';
      const label = bucket.name || (dimension === 'model' ? 'unlabeled' : `User #${bucket.id}`);
      return {
        id: bucket.id,
        name: label,
        email: dimension === 'user' ? label : '',
        requests: bucket.requests,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheTokens: bucket.cacheTokens,
        tokens: bucket.tokens,
        tokenListValueUsd: bucket.tokenListValueUsd,
        purchaseAllocatedCostCny: 0,
        multiplierCostCny: cost,
        unbookedAccountCount: bucket.missingAccounts.size,
        unbookedUserChargeCny: bucket.unpricedRevenue,
        costCoverageStatus: status,
        costAllocationScope: 'FinOps multiplier rules; fixed purchase remains account-level',
        ...financialFields(bucket.revenue, cost, bucket.unpricedRevenue),
      };
    });
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
      selling_multiplier_min: null,
      selling_multiplier_max: null,
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
      const group = {
        groupId: 0,
        groupName: '',
        requests: number(row.requests),
        totalTokens: number(row.totalTokens),
        cost,
        actualCost,
        sellingMultiplier: cost > 0 ? actualCost / cost : null,
      };
      stats.groups.push(group);
      stats.total_requests += group.requests;
      stats.total_input_tokens += number(row.inputTokens);
      stats.total_output_tokens += number(row.outputTokens);
      stats.total_cache_tokens += number(row.cacheTokens);
      stats.total_tokens += group.totalTokens;
      stats.total_cost += cost;
      stats.total_actual_cost += actualCost;
      for (const [field, value] of [['selling_multiplier_min', group.sellingMultiplier]]) {
        if (value !== null) {
          stats[field] = stats[field] === null ? value : Math.min(stats[field], value);
        }
      }
      for (const [field, value] of [['selling_multiplier_max', group.sellingMultiplier]]) {
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
    const knownByDay = new Map();
    const sources = new Set();
    const upstreamRates = [];
    let unpricedActualCost = 0;
    let unpricedUsageCount = 0;
    let hasKnownRate = false;
    for (const segment of segments) {
      sources.add(segment.source);
      if (segment.kind === 'multiplier') upstreamRates.push(number(segment.rate));
      for (const day of listDayKeys(segment.startDate, segment.endDate)) {
        const dayStats = dailyStats.get(day) || this.emptySourceStats();
        const known = segment.kind === 'multiplier';
        const cost = known ? calculateMultiplierCost(dayStats.total_cost, segment.rate) : null;
        if (known) {
          hasKnownRate = true;
          multiplierCost += number(cost);
        } else {
          unpricedActualCost += number(dayStats.total_actual_cost);
          unpricedUsageCount += number(dayStats.total_requests);
        }
        knownByDay.set(day, known);
        costsByDay.set(day, known ? number(cost) : 0);
      }
    }
    stats.calculated_multiplier_cost_cny = multiplierCost;
    stats.calculated_multiplier_cost_by_day = costsByDay;
    stats.multiplier_cost_known_by_day = knownByDay;
    stats.unpriced_actual_cost_cny = unpricedActualCost;
    stats.unpriced_usage_count = unpricedUsageCount;
    stats.multiplier_cost_available = hasKnownRate;
    stats.multiplier_cost_complete = unpricedUsageCount === 0 && (
      hasKnownRate || dailyValues.length === 0
    );
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
      const cost = stats.multiplier_cost_available
        ? number(stats.calculated_multiplier_cost_cny)
        : null;
      return {
        cost,
        costKnown: Boolean(stats.multiplier_cost_complete),
        unpricedRevenue: number(stats.unpriced_actual_cost_cny),
      };
    }
    return { cost: null, costKnown: false, unpricedRevenue: number(stats.total_actual_cost) };
  }

  async computeSourceEconomics(input) {
    if (!this.sourceUsageRepository) {
      const stats = summarizeModels(await this.sourceSnapshot(input));
      return {
        ...stats,
        calculated_cost_cny: 0,
        active_accounts: 0,
        missing_cost_count: stats.total_actual_cost > 0 ? 1 : 0,
        unpriced_actual_cost: stats.total_actual_cost,
        by_day: new Map(),
      };
    }
    const { accounts: rows } = await this.getDashboardUsageRows(input);
    const dailyByAccount = this.dailyAccountStats(rows);
    const accountIds = [...dailyByAccount.keys()].filter((id) => id > 0);
    const [accounts, timelines] = await Promise.all([
      this.repository.getAccountCostingProfiles({
        accountIds,
        start: input.start,
        end: input.end,
      }),
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
      if (calculated.cost !== null) summary.calculated_cost_cny += number(calculated.cost);
      if (!calculated.costKnown) {
        summary.missing_cost_count += 1;
        summary.unpriced_actual_cost += calculated.unpricedRevenue ?? number(stats.total_actual_cost);
      }

      for (const [day, dayStats] of byDay) {
        const point = summary.by_day.get(day) || {
          total_requests: 0,
          total_tokens: 0,
          total_cost: 0,
          total_actual_cost: 0,
          calculated_cost_cny: 0,
          unpriced_actual_cost: 0,
          missing_cost_count: 0,
        };
        const isMultiplier = ['probe_multiplier', 'manual_multiplier']
          .includes(String(account.costMode || account.costType));
        const dayKnown = isMultiplier
          ? Boolean(stats.multiplier_cost_known_by_day?.get(day))
          : this.calculateOperatingCost(account, dayStats).costKnown;
        const dayCost = isMultiplier
          ? number(stats.calculated_multiplier_cost_by_day?.get(day))
          : number(this.calculateOperatingCost(account, dayStats).cost);
        point.total_requests += number(dayStats.total_requests);
        point.total_tokens += number(dayStats.total_tokens);
        point.total_cost += number(dayStats.total_cost);
        point.total_actual_cost += number(dayStats.total_actual_cost);
        point.calculated_cost_cny += dayCost;
        if (!dayKnown) {
          point.missing_cost_count += 1;
          point.unpriced_actual_cost += number(dayStats.total_actual_cost);
        }
        summary.by_day.set(day, point);
      }
    }
    return summary;
  }

  async getSourceEconomics(input) {
    const key = this.usageRangeKey(input);
    if (this.sourceEconomicsInflight.has(key)) return this.sourceEconomicsInflight.get(key);
    const load = this.computeSourceEconomics(input)
      .finally(() => this.sourceEconomicsInflight.delete(key));
    this.sourceEconomicsInflight.set(key, load);
    return load;
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
      const hasKnownCost = Boolean(stats.multiplier_cost_available);
      const knownMultiplierCost = hasKnownCost
        ? number(stats.calculated_multiplier_cost_cny)
        : null;
      const unpricedRevenue = number(stats.unpriced_actual_cost_cny);
      const costKnown = Boolean(stats.multiplier_cost_complete);
      return {
        cost: knownMultiplierCost,
        fixedCost: 0,
        multiplierCost: knownMultiplierCost,
        costKnown,
        partial: !costKnown && hasKnownCost,
        unpricedRevenue,
        source: stats.multiplier_cost_source || (
          mode === 'manual_multiplier' ? 'manual_rate_snapshot' : 'supplier_rate_snapshot'
        ),
      };
    }
    return {
      cost: null,
      fixedCost: null,
      multiplierCost: null,
      costKnown: false,
      unpricedRevenue: number(stats.total_actual_cost),
      source: 'missing_finops_cost',
    };
  }

  enrichAccount(account, stats) {
    const revenue = number(stats.total_actual_cost);
    const calculated = this.calculateAccountCost(account, stats);
    const requests = number(stats.total_requests);
    const mode = String(account.costMode || account.costType || 'unconfigured');
    const missing = !calculated.costKnown;
    const unpricedRevenue = calculated.unpricedRevenue ?? (missing ? revenue : 0);
    const hasUsage = requests > 0 || revenue > 0;
    const coverageStatus = calculated.partial
      ? 'partial'
      : missing
        ? hasUsage ? 'missing' : 'pending'
        : requests
          ? 'complete'
          : 'configured';
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
      costCoverageStatus: coverageStatus,
      hasCostRecord: calculated.cost !== null,
      pricedUsageCount: calculated.partial ? Math.max(0, requests - number(stats.unpriced_usage_count))
        : missing ? 0 : requests,
      unpricedUsageCount: calculated.partial ? number(stats.unpriced_usage_count)
        : missing ? requests : 0,
      periodUpstreamMultiplierMin: nullableNumber(stats.upstream_multiplier_min),
      periodUpstreamMultiplierMax: nullableNumber(stats.upstream_multiplier_max),
      periodSellingMultiplierMin: nullableNumber(stats.selling_multiplier_min),
      periodSellingMultiplierMax: nullableNumber(stats.selling_multiplier_max),
      multiplierCostSource: calculated.source || '',
      ...financialFields(revenue, calculated.cost, unpricedRevenue),
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
    let unpricedActualCost = 0;
    let unpricedUsageCount = 0;
    let hasKnownRate = false;
    for (const segment of loaded) {
      sources.add(segment.source);
      if (segment.kind === 'multiplier') {
        multiplierCost += number(calculateMultiplierCost(segment.stats.total_cost, segment.rate));
        upstreamRates.push(number(segment.rate));
        hasKnownRate = true;
      } else {
        unpricedActualCost += number(segment.stats.total_actual_cost);
        unpricedUsageCount += number(segment.stats.total_requests);
      }
    }
    stats.calculated_multiplier_cost_cny = multiplierCost;
    stats.unpriced_actual_cost_cny = unpricedActualCost;
    stats.unpriced_usage_count = unpricedUsageCount;
    stats.multiplier_cost_available = hasKnownRate;
    stats.multiplier_cost_complete = unpricedUsageCount === 0 && hasKnownRate;
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
      const hasUsage = number(item.requests) > 0 || number(item.userChargeCny) > 0;
      if (hasUsage && ['missing', 'partial'].includes(String(item.costCoverageStatus))) {
        result.missingCostCount += 1;
      } else {
        result.pricedAccountCount += 1;
      }
      if (item.accountCostCny !== null && item.accountCostCny !== undefined) {
        result.accountCostCny += number(item.accountCostCny);
        result.fixedAcquisitionCostCny += number(item.fixedAcquisitionCostCny);
        result.multiplierCostCny += number(item.multiplierCostCny);
      }
      result.pricedUserChargeCny += number(item.pricedUserChargeCny);
      if (item.profitCny !== null && item.profitCny !== undefined) {
        result.profitCny += number(item.profitCny);
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
