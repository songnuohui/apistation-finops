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

export class SourceUsageService {
  constructor(repository, gateway, config, logger = console) {
    this.repository = repository;
    this.gateway = gateway;
    this.config = config;
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
    const stats = summarizeModels(source);
    const revenue = number(stats.total_actual_cost);
    const sourceAccountCost = number(stats.total_account_cost);
    const registeredProcurementCost = number(local.operations?.purchaseAllocatedCostCny);
    const effectiveCost = sourceAccountCost > 0 ? sourceAccountCost : registeredProcurementCost;
    const usingSourceCost = sourceAccountCost > 0;
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
        tokenListValueUsd: number(stats.total_cost),
        purchaseAllocatedCostCny: usingSourceCost ? 0 : registeredProcurementCost,
        allocatedCost: usingSourceCost ? 0 : registeredProcurementCost,
        allocatedCostCny: usingSourceCost ? 0 : registeredProcurementCost,
        registeredProcurementCostCny: registeredProcurementCost,
        multiplierCostCny: sourceAccountCost,
        sourceReportedAccountCostCny: sourceAccountCost,
        effectiveCostCny: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        grossProfit: profit,
        grossProfitCny: profit,
        bookedProfitCny: profit,
        grossMargin: revenue ? profit / revenue : null,
        profitBasis: usingSourceCost
          ? 'Sub2API 聚合账号成本'
          : 'FinOps 已登记采购成本',
      },
      usage: {
        requests: number(stats.total_requests),
        inputTokens: number(stats.total_input_tokens),
        outputTokens: number(stats.total_output_tokens),
        cacheTokens: number(stats.total_cache_tokens),
        activeUsers: 0,
        activeAccounts: 0,
        averageLatencyMs: 0,
      },
    };
  }

  async getSummary(input) {
    const [local, source] = await Promise.all([
      this.repository.getSummary(input),
      this.sourceSnapshot(input),
    ]);
    return this.summaryFrom(local, source);
  }

  async getOverviewDashboard(input) {
    const [local, source, breakdown] = await Promise.all([
      this.repository.getOverviewDashboard(input),
      this.sourceSnapshot(input),
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
      this.sourceSnapshot(input),
      this.repository.getTrend(input),
    ]);
    const stats = summarizeModels(source);
    const ratio = number(stats.total_cost) > 0
      ? number(stats.total_account_cost) / number(stats.total_cost)
      : 0;
    const sourceByDay = new Map(
      (Array.isArray(source?.trend) ? source.trend : []).map((item) => [String(item.date), item]),
    );
    const localByDay = new Map((local.items || []).map((item) => [String(item.day), item]));
    const days = [...new Set([...localByDay.keys(), ...sourceByDay.keys()])].sort();
    return {
      items: days.map((day) => {
        const point = sourceByDay.get(day) || {};
        const localPoint = localByDay.get(day) || {};
        const revenue = number(point.actual_cost);
        const sourceCost = Math.max(0, number(point.cost) * ratio);
        const registeredProcurementCost = number(localPoint.purchaseAllocatedCostCny);
        const cost = sourceCost > 0 ? sourceCost : registeredProcurementCost;
        return {
          day,
          ...financialFields(revenue, cost),
          allocatedCost: sourceCost > 0 ? 0 : registeredProcurementCost,
          allocatedCostCny: sourceCost > 0 ? 0 : registeredProcurementCost,
          purchaseAllocatedCostCny: sourceCost > 0 ? 0 : registeredProcurementCost,
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
        ? { cost: fixedCost, fixedCost, multiplierCost: 0, costKnown: true }
        : { cost: null, fixedCost: null, multiplierCost: null, costKnown: false };
    }
    if (mode === 'free') {
      return { cost: 0, fixedCost: 0, multiplierCost: 0, costKnown: true };
    }
    if (['probe_multiplier', 'manual_multiplier'].includes(mode)) {
      const upstream = nullableNumber(account.upstreamMultiplier);
      if (upstream === null || upstream < 0) {
        return { cost: null, fixedCost: 0, multiplierCost: null, costKnown: false };
      }
      const reference = number(stats.total_cost);
      const basis = account.basisMode === 'reference_cny'
        ? nullableNumber(account.cnyPerReferenceUnit)
        : 1;
      if (basis === null || basis <= 0) {
        return { cost: null, fixedCost: 0, multiplierCost: null, costKnown: false };
      }
      const cost = reference * upstream * basis;
      return { cost, fixedCost: 0, multiplierCost: cost, costKnown: true };
    }
    return { cost: null, fixedCost: null, multiplierCost: null, costKnown: false };
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
      multiplierCostSource: (
        calculated.costKnown
        && ['probe_multiplier', 'manual_multiplier'].includes(mode)
      ) ? 'source_api_aggregate' : '',
      ...financialFields(revenue, calculated.cost),
    };
  }

  async accountStats(input, accountId) {
    const payload = await this.gateway.dashboardModels({
      ...usageRange(input, this.config.timezone),
      accountId,
    });
    return summarizeModels(payload);
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
    const fanoutLimit = this.config.sub2apiUsageAccountFanoutLimit || 20;
    const canLoadAll = first.total > 0 && first.total <= fanoutLimit;
    let targetItems = first.items;
    if (canLoadAll && first.total > first.items.length) {
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
    const enriched = await Promise.all(targetItems.map(async (account) => {
      try {
        return this.enrichAccount(account, await this.accountStats(input, number(account.id)));
      } catch (error) {
        this.logger.warn('[source usage] account aggregate failed', account.id, error?.message || error);
        return this.enrichAccount(account, {});
      }
    }));
    const byId = new Map(enriched.map((item) => [number(item.id), item]));
    let visible = first.items.map((item) => byId.get(number(item.id)) || item);
    const sortField = {
      acquisitionCostCny: 'accountCostCny',
      userChargeCny: 'userChargeCny',
      profitCny: 'profitCny',
      requests: 'requests',
      tokens: 'tokens',
    }[input.sortBy];
    if (sortField && canLoadAll) {
      const sorted = [...enriched].sort(compare(sortField, input.sortOrder));
      visible = sorted.slice(input.offset, input.offset + input.pageSize);
    }
    return {
      ...first,
      items: visible,
      summary: this.accountSummary(enriched, first.total, !canLoadAll && first.total > enriched.length),
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
