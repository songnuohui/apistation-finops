function effectiveCostCny(costType, ignoredReferenceCost, purchaseAllocatedCostCny) {
  if (costType === 'free') return 0;
  return Number(purchaseAllocatedCostCny ?? ignoredReferenceCost ?? 0);
}

const users = [
  ['nuohuisong@gmail.com', 1, 1840.22, 312.45, 81.6, 0.739, 99998.48],
  ['278999990@qq.com', 21, 412.58, 96.82, 22.34, 0.769, 36.12],
  ['3071356532@qq.com', 15, 376.44, 88.31, 19.74, 0.776, 14.95],
  ['2758324196@qq.com', 3, 182.15, 41.88, 9.72, 0.768, 8.74],
  ['2417453689@qq.com', 57, 96.23, 23.42, 5.81, 0.752, 10.46],
  ['xingjianyuan94@hotmail.com', 30, 532.76, 132.44, 38.02, 0.713, 58.23],
  ['ariawang2006@qq.com', 65, 71.84, 18.67, 4.93, 0.736, 0.76],
  ['test12345678@qq.com', 4, 24.12, 4.91, 1.21, 0.754, -0.01],
].map(([email, id, revenue, ignoredReferenceCost, allocatedCost, margin, balance], index) => ({
  id, email, username: email.split('@')[0], tags: index < 2 ? ['核心用户'] : index === 7 ? ['测试'] : [],
  cashPaidCny: +(revenue * 0.96).toFixed(2), creditedCny: +(revenue * 1.04).toFixed(2),
  recognizedRevenueCny: revenue, userChargeCny: +(revenue * 1.04).toFixed(2),
  tokenListValueUsd: +(revenue * 0.17).toFixed(2),
  revenue, revenueCny: revenue, tokens: Math.round(revenue * 1_180_000), requests: Math.round(revenue * 7.6),
  allocatedCost, purchaseAllocatedCostCny: allocatedCost,
  effectiveCostCny: allocatedCost, fullyLoadedCostCny: allocatedCost, bookedCostCny: allocatedCost,
  grossProfit: +(revenue - allocatedCost).toFixed(2),
  grossProfitCny: +(revenue - allocatedCost).toFixed(2), bookedProfitCny: +(revenue - allocatedCost).toFixed(2),
  grossMargin: revenue ? +((revenue - allocatedCost) / revenue).toFixed(4) : null,
  costCoverageStatus: 'complete', unbookedAccountCount: 0,
  balanceCny: balance, balanceCurrency: 'CNY', lastActiveAt: new Date(Date.now() - index * 1_840_000).toISOString(),
}));

const accounts = [
  ['RoseGalatea9974+see3@outlook.com', 2745, 'OpenAI', 'Cloud Seats', 'subscription', 186.31, 48.22, 35.00, 7.2, '2026-08-01'],
  ['PaulaAcacia8221+see2@outlook.com', 2742, 'OpenAI', 'Cloud Seats', 'subscription', 142.88, 36.91, 35.00, 5.1, '2026-08-01'],
  ['quillandream1184+c2api2@outlook.com', 2749, 'OpenAI', 'Seat Market', 'one_time', 121.44, 28.50, 26.00, 9.0, '2026-07-28'],
  ['qirinadley5574+c2api6@outlook.com', 2747, 'OpenAI', 'Seat Market', 'one_time', 98.22, 21.76, 26.00, 6.3, '2026-07-28'],
  ['Claude Kiro 90% Cache #1', 1804, 'Anthropic', 'Kiro Direct', 'metered', 84.64, 49.27, 44.18, 0, null],
  ['Gemini Pro Shared #2', 1908, 'Gemini', 'Google Direct', 'prepaid', 56.31, 18.64, 13.22, 2.5, '2026-09-15'],
].map(([name, id, platform, supplier, costType, revenue, ignoredReferenceCost, periodCost, idleCost, expiresAt], index) => ({
  id, name, platform, supplier, costType, purchaseBatch: `2026-07-B${index + 1}`,
  revenue, revenueCny: revenue, recognizedRevenueCny: revenue, userChargeCny: +(revenue * 1.04).toFixed(2),
  tokenListValueUsd: +(revenue * 0.16).toFixed(2),
  periodCost, periodCostCny: periodCost, purchaseAllocatedCostCny: periodCost,
  effectiveCostCny: effectiveCostCny(costType, 0, periodCost),
  fullyLoadedCost: effectiveCostCny(costType, 0, periodCost),
  fullyLoadedCostCny: effectiveCostCny(costType, 0, periodCost),
  bookedCostCny: effectiveCostCny(costType, 0, periodCost),
  idleCost: costType === 'metered' || costType === 'free' ? 0 : idleCost,
  grossProfit: +(revenue - effectiveCostCny(costType, 0, periodCost)).toFixed(2),
  grossProfitCny: +(revenue - effectiveCostCny(costType, 0, periodCost)).toFixed(2),
  bookedProfitCny: +(revenue - effectiveCostCny(costType, 0, periodCost)).toFixed(2),
  grossMargin: revenue ? +((revenue - effectiveCostCny(costType, 0, periodCost)) / revenue).toFixed(4) : null,
  costCoverageStatus: 'complete', hasCostRecord: true, costConfigurationConflict: costType === 'free' && periodCost > 0,
  requests: Math.round(revenue * 16), tokens: Math.round(revenue * 2_400_000), expiresAt,
  status: 'active', tags: index < 2 ? ['GPT PLUS', '主力'] : ['备用'],
}));

const models = [
  ['gpt-5.6-sol', 3690, 520_100_000, 694.93, 588.92, 35.31, 553.61],
  ['gpt-5.6-terra', 2979, 407_530_000, 341.04, 288.90, 16.11, 272.79],
  ['gpt-5.5', 1255, 126_480_000, 179.88, 152.45, 9.82, 142.63],
  ['claude-opus-4-8', 437, 122_530_000, 303.66, 258.11, 55.41, 202.70],
  ['gpt-5.4', 584, 23_700_000, 22.80, 19.38, 1.04, 18.34],
].map(([name, requests, tokens, standardCost, revenue, cost, profit]) => ({
  name, requests, tokens, tokenListValueUsd: standardCost,
  userChargeCny: +(revenue * 1.04).toFixed(2), recognizedRevenueCny: revenue, revenue, revenueCny: revenue,
  purchaseAllocatedCostCny: cost, effectiveCostCny: cost, fullyLoadedCostCny: cost, bookedCostCny: cost,
  cost, costCny: cost, profit, profitCny: profit, grossProfitCny: profit, bookedProfitCny: profit,
  unbookedAccountCount: 0, costCoverageStatus: 'complete', margin: profit / revenue,
}));

const trend = Array.from({ length: 14 }, (_, index) => {
  const day = new Date(Date.now() - (13 - index) * 86_400_000);
  const revenue = +(72 + index * 2.8 + [5, -4, 8, 2][index % 4]).toFixed(2);
  const allocatedCost = +(12.4 + (index % 4) * 0.8).toFixed(2);
  const effectiveCost = allocatedCost;
  const profit = +(revenue - effectiveCost).toFixed(2);
  return {
    day: day.toISOString().slice(0, 10), revenue, revenueCny: revenue, recognizedRevenueCny: revenue,
    userChargeCny: +(revenue * 1.04).toFixed(2), allocatedCost, allocatedCostCny: allocatedCost,
    purchaseAllocatedCostCny: allocatedCost, effectiveCostCny: effectiveCost, fullyLoadedCostCny: effectiveCost,
    bookedCostCny: effectiveCost, profit, profitCny: profit, grossProfitCny: profit, bookedProfitCny: profit,
  };
});

const cashTransactions = [
  ['sub2_20260715dTC3tOzp', 'recharge', 'in', 2, 'CNY', 'Alipay', 'nuohuisong@gmail.com'],
  ['sub2_20260715quhRIFQm', 'recharge', 'in', 2, 'CNY', 'Alipay', '2417453689@qq.com'],
  ['PUR-202607-0018', 'account_purchase', 'out', 35, 'CNY', 'Manual', 'Cloud Seats'],
  ['sub2_20260715D22eMcKU', 'affiliate_rebate', 'out', 0.1, 'CNY', 'Alipay', '2758324196@qq.com'],
].map(([reference, type, direction, amount, currency, method, party], index) => ({
  id: index + 1, reference, type, direction, amount, currency, method, party,
  status: 'confirmed', occurredAt: new Date(Date.now() - index * 3_600_000).toISOString(),
  baseAmountCny: currency === 'CNY' ? amount : 0, creditedAmount: type === 'recharge' ? amount : 0,
  creditedCurrency: 'CNY',
  creditedAmountCny: type === 'recharge' ? amount : 0,
}));

const demoCostProfiles = [
  { id: 1, name: 'PLUS 月租账号', costType: 'subscription', currency: 'CNY', allocationMethod: 'standard_cost_weight', version: 1, accountCount: 12 },
  { id: 2, name: 'OpenAI 按量', costType: 'metered', currency: 'CNY', allocationMethod: 'token_weight', version: 2, accountCount: 4 },
  { id: 3, name: '免费测试资源', costType: 'free', currency: 'CNY', allocationMethod: 'none', version: 1, accountCount: 2 },
];

export class DemoRepository {
  constructor(config) {
    this.config = config;
    this.users = users.map((item) => ({ ...item, tags: [...item.tags] }));
    this.accounts = accounts.map((item) => ({ ...item, tags: [...item.tags] }));
    this.cashTransactions = cashTransactions.map((item) => ({ ...item }));
    this.costProfiles = demoCostProfiles.map((profile) => ({ ...profile }));
    this.accountCostPeriods = [];
  }

  async getBootstrap() {
    return {
      mode: 'demo', baseCurrency: 'CNY', billingUnit: 'CNY', balanceCurrency: 'CNY', referenceCurrency: 'USD',
      timezone: this.config.timezone, syncLagSeconds: 38,
    };
  }

  async getSummary() {
    const revenue = trend.reduce((sum, item) => sum + item.revenue, 0);
    const userChargeCny = trend.reduce((sum, item) => sum + item.userChargeCny, 0);
    const allocatedCost = trend.reduce((sum, item) => sum + item.allocatedCost, 0);
    const effectiveCostCny = trend.reduce((sum, item) => sum + item.effectiveCostCny, 0);
    const grossProfit = revenue - effectiveCostCny;
    return {
      cash: { received: 1384.2, rechargeReceived: 1384.2, subscriptionReceived: 86.4, totalReceived: 1470.6, refunds: 24.1, gatewayFees: 8.42, procurementSpend: 188.5, netInflow: 1249.58 },
      operations: {
        revenue, revenueCny: revenue, recognizedRevenueCny: revenue, userChargeCny,
        pendingRevenueCny: 0, pendingUsageCount: 0,
        tokenListValueUsd: models.reduce((sum, item) => sum + item.tokenListValueUsd, 0),
        allocatedCost, allocatedCostCny: allocatedCost, purchaseAllocatedCostCny: allocatedCost,
        effectiveCostCny, fullyLoadedCostCny: effectiveCostCny, bookedCostCny: effectiveCostCny,
        grossProfit, grossProfitCny: grossProfit, bookedProfitCny: grossProfit, profitBasis: 'booked_cost_only',
        unbookedAccountCount: 0, unbookedRevenueCny: 0, unbookedUserChargeCny: 0, costConflictCount: 0,
        grossMargin: grossProfit / revenue,
      },
      usage: { requests: 9470, inputTokens: 124_640_000, outputTokens: 5_520_000, cacheTokens: 1_110_000_000, activeUsers: 20, activeAccounts: 18, averageLatencyMs: 27480 },
      alerts: [
        { severity: 'high', title: '2 个账号缺少 CNY 成本档案', detail: '当前利润仅反映已登记成本，请补充账号成本期间' },
        { severity: 'medium', title: '固定账号闲置成本偏高', detail: '近 7 天闲置成本 ¥29.80' },
        { severity: 'low', title: '数据同步正常', detail: '最近同步延迟 38 秒' },
      ],
    };
  }

  async getTrend() { return trend; }
  async getUsageBreakdown() { return models; }

  async listUsers({ search = '', page = 1, pageSize = 20 } = {}) {
    const filtered = this.users.filter((item) => `${item.email} ${item.username}`.toLowerCase().includes(search.toLowerCase()));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async listAccounts({ search = '', page = 1, pageSize = 20 } = {}) {
    const filtered = this.accounts.filter((item) => `${item.name} ${item.platform} ${item.supplier}`.toLowerCase().includes(search.toLowerCase()));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async getSupplierOverview({ search = '' } = {}) {
    const term = String(search || '').trim().toLowerCase();
    const filtered = this.accounts.filter((item) => `${item.name} ${item.platform} ${item.supplier} ${item.purchaseBatch}`.toLowerCase().includes(term));
    const grouped = new Map();

    for (const account of filtered) {
      const supplier = account.supplier?.trim() || '未标记供应商';
      const current = grouped.get(supplier) || {
        supplier, platforms: new Set(), accountCount: 0, activeAccounts: 0, expiringAccounts: 0,
        missingRuleCount: 0, requests: 0, tokens: 0, revenue: 0, userChargeCny: 0,
        purchaseSpend: 0, effectiveCostCny: 0, unbookedAccountCount: 0, costConflictCount: 0,
      };
      current.platforms.add(account.platform);
      current.accountCount += 1;
      current.activeAccounts += account.status === 'active' ? 1 : 0;
      current.expiringAccounts += account.expiresAt && new Date(account.expiresAt).getTime() < Date.now() + 14 * 86_400_000 ? 1 : 0;
      current.missingRuleCount += account.costType === 'unconfigured' ? 1 : 0;
      current.requests += Number(account.requests || 0);
      current.tokens += Number(account.tokens || 0);
      current.revenue += Number(account.revenue || 0);
      current.userChargeCny += Number(account.userChargeCny || 0);
      current.purchaseSpend += Number(account.periodCost || 0);
      current.effectiveCostCny += Number(account.effectiveCostCny || 0);
      current.unbookedAccountCount += account.costCoverageStatus === 'missing' ? 1 : 0;
      current.costConflictCount += account.costConfigurationConflict ? 1 : 0;
      grouped.set(supplier, current);
    }

    const items = [...grouped.values()].map((item) => {
      const grossProfit = item.revenue - item.effectiveCostCny;
      return {
        ...item,
        platforms: [...item.platforms],
        revenueCny: item.revenue,
        recognizedRevenueCny: item.revenue,
        purchaseAllocatedCostCny: item.purchaseSpend,
        fullyLoadedCostCny: item.effectiveCostCny, bookedCostCny: item.effectiveCostCny,
        grossProfit,
        grossProfitCny: grossProfit, bookedProfitCny: grossProfit,
        grossMargin: item.revenue ? grossProfit / item.revenue : null,
      };
    }).sort((a, b) => b.purchaseSpend - a.purchaseSpend || b.revenue - a.revenue);

    const purchases = filtered.map((account) => ({
      id: `demo-${account.id}`,
      accountId: account.id,
      accountName: account.name,
      supplier: account.supplier?.trim() || '未标记供应商',
      purchaseBatch: account.purchaseBatch || '未标记批次',
      costProfile: account.costType,
      originalAmount: account.periodCost,
      originalCurrency: this.config.baseCurrency,
      totalCost: account.periodCost,
      effectiveFrom: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      effectiveTo: account.expiresAt,
      status: account.status,
    })).sort((a, b) => Number(b.totalCost) - Number(a.totalCost));

    const summary = items.reduce((result, item) => ({
      supplierCount: result.supplierCount + 1,
      accountCount: result.accountCount + item.accountCount,
      purchaseSpend: result.purchaseSpend + item.purchaseSpend,
      revenue: result.revenue + item.revenue,
      recognizedRevenueCny: result.recognizedRevenueCny + item.recognizedRevenueCny,
      userChargeCny: result.userChargeCny + item.userChargeCny,
      effectiveCostCny: result.effectiveCostCny + item.effectiveCostCny,
      unbookedAccountCount: result.unbookedAccountCount + item.unbookedAccountCount,
      costConflictCount: result.costConflictCount + item.costConflictCount,
      grossProfit: result.grossProfit + item.grossProfit,
      missingSupplierAccounts: result.missingSupplierAccounts + (item.supplier === '未标记供应商' ? item.accountCount : 0),
    }), {
      supplierCount: 0, accountCount: 0, purchaseSpend: 0, revenue: 0, recognizedRevenueCny: 0,
      userChargeCny: 0, effectiveCostCny: 0, unbookedAccountCount: 0, costConflictCount: 0, grossProfit: 0,
      missingSupplierAccounts: 0,
    });

    return { summary, items, purchases };
  }

  async listCashTransactions({ page = 1, pageSize = 20, search = '' } = {}) {
    const term = String(search || '').trim().toLowerCase();
    const filtered = term ? this.cashTransactions.filter((item) => `${item.reference} ${item.type} ${item.method} ${item.party}`.toLowerCase().includes(term)) : this.cashTransactions;
    const inflow = this.cashTransactions.filter((item) => item.direction === 'in').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const outflow = this.cashTransactions.filter((item) => item.direction === 'out').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const refunds = this.cashTransactions.filter((item) => item.type === 'refund').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize,
      summary: { inflow, outflow, refunds, net: inflow - outflow, transactions: this.cashTransactions.length },
    };
  }

  async createCashTransaction(input, actor = 'admin') {
    const type = input.transactionType;
    const item = {
      id: Math.max(0, ...this.cashTransactions.map((row) => Number(row.id) || 0)) + 1,
      reference: input.reference || `MAN-${Date.now()}`,
      type,
      direction: input.direction,
      amount: Number(input.originalAmount),
      baseAmount: Number(input.baseAmount),
      baseAmountCny: Number(input.baseAmount),
      currency: input.originalCurrency,
      creditedAmount: 0,
      creditedAmountCny: 0,
      creditedCurrency: 'CNY',
      method: input.paymentMethod,
      party: input.party || '',
      status: 'confirmed',
      occurredAt: new Date(input.occurredAt || Date.now()).toISOString(),
      actor,
      notes: input.notes || '',
    };
    this.cashTransactions.unshift(item);
    return item;
  }

  async getReconciliation() {
    return [
      { type: 'credit_usage_cny', label: '钱包扣费对账', unit: 'CNY', status: 'matched', sourceTotal: 1323.0831, finopsTotal: 1323.0831, difference: 0, checkedAt: new Date().toISOString() },
      { type: 'payment', label: '支付订单', unit: 'CNY', status: 'matched', sourceTotal: 1384.2, finopsTotal: 1384.2, difference: 0, checkedAt: new Date().toISOString() },
      { type: 'cost', label: '账号采购成本', unit: 'CNY', status: 'warning', sourceTotal: 188.5, finopsTotal: 158.7, difference: 29.8, checkedAt: new Date().toISOString() },
    ];
  }

  async getSyncState() {
    return { status: 'healthy', lagSeconds: 38, lastSuccessAt: new Date(Date.now() - 38_000).toISOString(), rowsSynced: 38944 };
  }

  async getSyncDetails() {
    const now = Date.now();
    const sources = [
      { sourceName: 'dimensions', label: '用户与账号', status: 'healthy', lagSeconds: 36, lastSuccessAt: new Date(now - 36_000).toISOString(), rowsSynced: this.users.length + this.accounts.length, lastError: null },
      { sourceName: 'usage_logs', label: '用量与扣费', status: 'healthy', lagSeconds: 38, lastSuccessAt: new Date(now - 38_000).toISOString(), rowsSynced: 38_712, lastError: null },
      { sourceName: 'payment_orders', label: '充值与退款', status: 'healthy', lagSeconds: 35, lastSuccessAt: new Date(now - 35_000).toISOString(), rowsSynced: 218, lastError: null },
      { sourceName: 'redeem_codes', label: '兑换码与人工调账', status: 'healthy', lagSeconds: 34, lastSuccessAt: new Date(now - 34_000).toISOString(), rowsSynced: 86, lastError: null },
      { sourceName: 'user_affiliate_ledger', label: '邀请返利额度', status: 'healthy', lagSeconds: 33, lastSuccessAt: new Date(now - 33_000).toISOString(), rowsSynced: 44, lastError: null },
      { sourceName: 'payment_audit_logs', label: '支付审计', status: 'healthy', lagSeconds: 32, lastSuccessAt: new Date(now - 32_000).toISOString(), rowsSynced: 123, lastError: null },
      { sourceName: 'user_subscriptions', label: '用户订阅', status: 'healthy', lagSeconds: 33, lastSuccessAt: new Date(now - 33_000).toISOString(), rowsSynced: 18, lastError: null },
      { sourceName: 'credit_reconciliation', label: '额度对账', status: 'healthy', lagSeconds: 34, lastSuccessAt: new Date(now - 34_000).toISOString(), rowsSynced: 20, lastError: null },
      { sourceName: 'reconciliation', label: '自动对账', status: 'healthy', lagSeconds: 65, lastSuccessAt: new Date(now - 65_000).toISOString(), rowsSynced: 8, lastError: null },
    ];
    return {
      status: 'healthy',
      lagSeconds: Math.max(...sources.map((item) => item.lagSeconds)),
      lastSuccessAt: new Date(Math.min(...sources.map((item) => new Date(item.lastSuccessAt).getTime()))).toISOString(),
      rowsSynced: sources.reduce((sum, item) => sum + item.rowsSynced, 0),
      errorCount: 0,
      sources,
    };
  }

  // The methods below keep demo writes visible for the lifetime of the process.
  async listCostProfiles() {
    return this.costProfiles;
  }

  async createCostProfile(input) {
    const id = Math.max(0, ...this.costProfiles.map((profile) => profile.id)) + 1;
    const profile = { id, ...input, version: 1, accountCount: 0 };
    this.costProfiles.unshift(profile);
    return profile;
  }

  async createAccountCostPeriod(input) {
    const account = this.accounts.find((item) => Number(item.id) === Number(input.accountId));
    const selectedProfile = input.costProfileId
      ? this.costProfiles.find((item) => Number(item.id) === Number(input.costProfileId))
      : null;
    if ((selectedProfile?.costType || account?.costType) === 'free') {
      throw Object.assign(new Error('free accounts cannot have a CNY cost period'), { statusCode: 409 });
    }
    const id = Math.max(0, ...this.accountCostPeriods.map((period) => period.id)) + 1;
    const period = { id, ...input, status: 'active' };
    this.accountCostPeriods.push(period);
    if (account) {
      if (selectedProfile) {
        account.costType = selectedProfile.costType;
        selectedProfile.accountCount += 1;
      }
      if (input.supplier) account.supplier = input.supplier;
      if (input.purchaseBatch) account.purchaseBatch = input.purchaseBatch;
      if (Array.isArray(input.tags)) account.tags = input.tags;
      account.periodCost = +(Number(account.periodCost || 0) + Number(input.baseAmount || 0) + Number(input.feeAmount || 0) + Number(input.taxAmount || 0)).toFixed(2);
      account.purchaseAllocatedCostCny = account.periodCost;
      account.effectiveCostCny = +effectiveCostCny(account.costType, 0, account.periodCost).toFixed(2);
      account.fullyLoadedCost = account.effectiveCostCny;
      account.fullyLoadedCostCny = account.effectiveCostCny;
      account.bookedCostCny = account.effectiveCostCny;
      account.grossProfit = +(Number(account.recognizedRevenueCny || account.revenue || 0) - account.fullyLoadedCost).toFixed(2);
      account.grossProfitCny = account.grossProfit;
      account.bookedProfitCny = account.grossProfit;
      account.hasCostRecord = true;
      account.costCoverageStatus = 'complete';
      account.costConfigurationConflict = account.costType === 'free';
      account.grossMargin = account.revenue ? +(account.grossProfit / account.revenue).toFixed(4) : null;
    }
    return period;
  }
}
