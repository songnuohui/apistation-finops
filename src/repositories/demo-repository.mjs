import { splitFixedCostCny } from '../services/cost-accounting.mjs';
import { buildSupplierQualityScores } from '../services/supplier-quality.mjs';

function effectiveCostCny(costType, ignoredReferenceCost, purchaseAllocatedCostCny) {
  if (costType === 'free') return 0;
  return Number(purchaseAllocatedCostCny ?? ignoredReferenceCost ?? 0);
}

function pageResult(items, page = 1, pageSize = 20) {
  const total = items.length;
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function copySupplierConnection(connection, { includeCiphertext = false } = {}) {
  const copy = { ...connection };
  if (!includeCiphertext) delete copy.credentialsCiphertext;
  return copy;
}

function copySupplierDetail(detail) {
  return {
    keys: detail.keys.map((key) => ({
      ...key,
      accountLinks: (key.accountLinks || []).map((link) => ({ ...link })),
    })),
    balances: detail.balances.map((item) => ({ ...item })),
    checks: detail.checks.map((item) => ({ ...item })),
    alerts: detail.alerts.map((item) => ({ ...item, details: { ...(item.details || {}) } })),
  };
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
  recognizedRevenueCny: revenue, userChargeCny: revenue,
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
  id, name, platform, supplier, costType,
  costMode: costType === 'free' ? 'free' : 'fixed_purchase',
  purchaseBatch: `2026-07-B${index + 1}`,
  revenue, revenueCny: revenue, recognizedRevenueCny: revenue, userChargeCny: revenue,
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
  userChargeCny: revenue, recognizedRevenueCny: revenue, revenue, revenueCny: revenue,
  purchaseAllocatedCostCny: cost, effectiveCostCny: cost, fullyLoadedCostCny: cost, bookedCostCny: cost,
  cost, costCny: cost, profit, profitCny: profit, grossProfitCny: profit, bookedProfitCny: profit,
  unbookedAccountCount: 0, costCoverageStatus: 'complete', margin: profit / revenue, grossMargin: profit / revenue,
}));

const trend = Array.from({ length: 14 }, (_, index) => {
  const day = new Date(Date.now() - (13 - index) * 86_400_000);
  const revenue = +(72 + index * 2.8 + [5, -4, 8, 2][index % 4]).toFixed(2);
  const allocatedCost = +(12.4 + (index % 4) * 0.8).toFixed(2);
  const effectiveCost = allocatedCost;
  const profit = +(revenue - effectiveCost).toFixed(2);
  return {
    day: day.toISOString().slice(0, 10), revenue, revenueCny: revenue, recognizedRevenueCny: revenue,
    userChargeCny: revenue, allocatedCost, allocatedCostCny: allocatedCost,
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

const nonCashBalanceCredits = [
  {
    id: 1, sourceTable: 'redeem_codes', sourceId: 'DEMO-001', type: 'redeem', amountCny: 8,
    occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), action: 'used', redeemType: 'balance',
    sourceUserId: 1, email: 'nuohuisong@gmail.com', username: 'nuohuisong',
  },
];

const demoCostProfiles = [
  { id: 1, name: 'PLUS 月租账号', costType: 'subscription', costMode: 'fixed_purchase', basisMode: 'revenue_backsolve', currency: 'CNY', allocationMethod: 'standard_cost_weight', version: 1, accountCount: 12 },
  { id: 2, name: 'OpenAI 探测倍率', costType: 'metered', costMode: 'probe_multiplier', basisMode: 'revenue_backsolve', currency: 'CNY', allocationMethod: 'token_weight', version: 2, accountCount: 4 },
  { id: 3, name: '免费测试资源', costType: 'free', costMode: 'free', basisMode: 'revenue_backsolve', currency: 'CNY', allocationMethod: 'none', version: 1, accountCount: 2 },
];

const demoMonitorDefinitions = [
  ['GPT PLUS【限时特惠】', 1, 'gpt-5.4', 0.08, 96.32, 2053, 6],
  ['GPT PLUS【稳定】', 2, 'gpt-5.4', 0.08, 97.02, 3205, 5],
  ['GPT pluspro 混池【应急】', 3, 'gpt-5.4', 0.12, 97.99, 1404, 11],
  ['GPT PRO【稳定】', 4, 'gpt-5.4', 0.16, 99.21, 1235, 6],
  ['GPT PRO【兜底】', 5, 'gpt-5.4', 0.20, 99.40, 2416, 28],
].map(([name, sourceGroupId, modelLabel, effectiveMultiplier, availabilityPercent, averageLatencyMs, averagePingLatencyMs], index) => ({
  id: index + 1,
  name,
  sourceGroupId,
  modelLabel,
  displayOrder: index,
  enabled: true,
  status: 'healthy',
  availableAccountCount: index < 2 ? 12 : 8,
  totalAccountCount: index < 2 ? 12 : 8,
  configuredGroupMultiplier: effectiveMultiplier,
  groupMultiplier: effectiveMultiplier,
  userMultiplier: effectiveMultiplier,
  effectiveMultiplier,
  averageLatencyMs,
  averagePingLatencyMs,
  availabilityPercent,
  lastObservedAt: new Date(Date.now() - (3 + index) * 60_000).toISOString(),
}));

function demoMonitorHistory(group) {
  const failed = Math.max(0, Math.min(12, Math.round(60 * (100 - group.availabilityPercent) / 100)));
  const history = Array.from({ length: 60 }, (_, index) => ({
    observedAt: new Date(Date.now() - (59 - index) * 60_000).toISOString(),
    status: 'healthy',
  }));
  for (let index = 0; index < failed; index += 1) {
    const position = Math.min(59, 8 + index * 7);
    history[position].status = index % 3 === 0 ? 'degraded' : 'unavailable';
  }
  return history;
}

export class DemoRepository {
  constructor(config) {
    this.config = config;
    this.users = users.map((item) => ({ ...item, tags: [...item.tags] }));
    this.accounts = accounts.map((item) => ({ ...item, tags: [...item.tags] }));
    this.cashTransactions = cashTransactions.map((item) => ({ ...item }));
    this.nonCashBalanceCredits = nonCashBalanceCredits.map((item) => ({ ...item }));
    this.costProfiles = demoCostProfiles.map((profile) => ({ ...profile }));
    this.monitorGroups = demoMonitorDefinitions.map((group) => ({ ...group }));
    this.supplierConnections = [{
      id: 1, supplierId: 1, supplierName: 'Cloud Seats', name: '主账号', adapterType: 'sub2api',
      detectedAdapterType: 'sub2api', baseUrl: 'https://supplier.example.com', authMode: 'access_token',
      credentialLabel: 'nu***@example.com', credentialsConfigured: true, credentialsCiphertext: 'demo-encrypted', enabled: true,
      inventoryIntervalSeconds: 600, inventoryIntervalMinutes: 10, activeCheckEnabled: true, activeCheckLimit: 20,
      lowBalanceThreshold: 5, balanceCurrency: 'USD', balance: 10.84, connectionStatus: 'ok',
      qualityMonitorMode: 'hybrid',
      keyCount: 4, activeKeyCount: 4, failedKeyCount: 0, openAlertCount: 1,
      lastSyncAt: new Date(Date.now() - 3 * 60_000).toISOString(), lastSuccessAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      nextSyncAt: new Date(Date.now() + 7 * 60_000).toISOString(), consecutiveFailures: 0, lastError: '',
    }];
    const supplierNow = Date.now();
    this.supplierConnectionDetails = new Map([[
      1,
      {
        keys: [
          { id:1,externalId:'101',name:'plus-特惠',maskedKey:'sk-db8...cb4b',status:'active',groupName:'ChatGPT-Plus',rateMultiplier:0.05,quotaTotal:null,quotaUsed:3.2,quotaRemaining:null,quotaCurrency:'USD',lastCheckStatus:'ok',lastCheckMethod:'billing_metadata',lastCheckAt:new Date(supplierNow-180000).toISOString(),accountLinks:[{accountId:2745,accountName:'RoseGalatea9974+see3@outlook.com'}] },
          { id:2,externalId:'102',name:'pro兜底',maskedKey:'sk-286...b8eb',status:'active',groupName:'ChatGPT-Pro',rateMultiplier:0.15,quotaTotal:null,quotaUsed:4.13,quotaRemaining:null,quotaCurrency:'USD',lastCheckStatus:'ok',lastCheckMethod:'billing_metadata',lastCheckAt:new Date(supplierNow-190000).toISOString(),accountLinks:[] },
          { id:3,externalId:'103',name:'cc-pro',maskedKey:'sk-abd...c5a0',status:'active',groupName:'Claude-Kiro',rateMultiplier:0.03,quotaTotal:null,quotaUsed:0,quotaRemaining:null,quotaCurrency:'USD',lastCheckStatus:'unsupported',lastCheckMethod:'billing_metadata',lastCheckAt:new Date(supplierNow-200000).toISOString(),accountLinks:[] },
          { id:4,externalId:'104',name:'PLUS-稳定',maskedKey:'sk-9cb...ddab',status:'active',groupName:'ChatGPT-Plus',rateMultiplier:0.06,quotaTotal:null,quotaUsed:1.82,quotaRemaining:null,quotaCurrency:'USD',lastCheckStatus:'ok',lastCheckMethod:'billing_metadata',lastCheckAt:new Date(supplierNow-210000).toISOString(),accountLinks:[] },
        ],
        balances: Array.from({ length: 8 }, (_, index) => ({ balance:10.84+index*0.31,currency:'USD',observedAt:new Date(supplierNow-index*3600000).toISOString() })),
        checks: [],
        alerts: [{ id:1,keyId:3,type:'multiplier_changed',severity:'warning',status:'open',title:'密钥倍率发生变化',message:'cc-pro：0.04x → 0.03x',lastSeenAt:new Date(supplierNow-3600000).toISOString(),occurrenceCount:1 }],
      },
    ]]);
    this.supplierQualityTargets = [{
      id: 1, connectionId: 1, keyId: 1, externalKeyId: '101', keyName: 'plus-鐗规儬',
      maskedKey: 'sk-db8...cb4b', keyStatus: 'active', groupName: 'ChatGPT-Plus', rateMultiplier: 0.05,
      model: 'gpt-4o-mini', enabled: true, intervalSeconds: 1800, maxOutputTokens: 1,
      nextProbeAt: new Date(Date.now() + 12 * 60_000).toISOString(),
      lastProbeAt: new Date(Date.now() - 8 * 60_000).toISOString(), lastStatus: 'ok', lastError: '',
    }];
    this.supplierQualityObservations = [
      { id: 1, connectionId: 1, sourceKind: 'passive_usage', keyId: 1, model: 'gpt-4o-mini', status: 'ok', availabilitySample: false, ttftMs: 780, durationMs: 2400, rateMultiplier: 0.05, observedAt: new Date(Date.now() - 5 * 60_000).toISOString(), metadata: {} },
      { id: 2, connectionId: 1, sourceKind: 'passive_monitor', keyId: null, model: 'gpt-4o-mini', status: 'ok', availabilitySample: true, durationMs: 1100, pingLatencyMs: 42, observedAt: new Date(Date.now() - 15 * 60_000).toISOString(), metadata: {} },
      { id: 3, connectionId: 1, sourceKind: 'active_probe', targetId: 1, keyId: 1, model: 'gpt-4o-mini', status: 'ok', availabilitySample: true, ttftMs: 920, durationMs: 1800, rateMultiplier: 0.05, observedAt: new Date(Date.now() - 8 * 60_000).toISOString(), metadata: {} },
    ];
    this.alertNotificationSettings = {
      enabled:false,qqNumber:'',onebotEndpoint:'',accessTokenConfigured:false,
      accessTokenCiphertext:'',updatedBy:'',updatedAt:null,
    };
    this.sub2ApiServiceAuthSettings = {
      enabled:false,email:'',credentialsConfigured:false,credentialsCiphertext:'',
      lastAuthenticatedAt:null,tokenExpiresAt:null,lastError:'',updatedBy:'',updatedAt:null,
    };
    this.supplierAlertDeliveries = new Map();
    this.accountProfitGuardPolicies = new Map();
    this.accountCostPeriods = this.accounts.map((account, index) => {
      const effectiveFrom = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const effectiveTo = account.expiresAt
        ? new Date(`${account.expiresAt}T23:59:59+08:00`).toISOString()
        : new Date(Date.now() + 30 * 86_400_000).toISOString();
      const period = {
        id: index + 1,
        accountId: account.id,
        costProfileId: null,
        originalAmount: account.periodCost,
        baseAmount: account.periodCost,
        feeAmount: 0,
        taxAmount: 0,
        originalCurrency: 'CNY',
        fxRate: '1',
        supplier: account.supplier,
        purchaseBatch: account.purchaseBatch,
        effectiveFrom,
        effectiveTo,
        notes: '演示数据',
        status: 'active',
      };
      account.currentCostPeriodId = period.id;
      account.currentCostProfileId = null;
      account.currentOriginalAmount = period.originalAmount;
      account.currentFeeAmount = period.feeAmount;
      account.currentTaxAmount = period.taxAmount;
      account.currentEffectiveFrom = period.effectiveFrom;
      account.currentEffectiveTo = period.effectiveTo;
      account.currentCostNotes = period.notes;
      return period;
    });
  }

  async getBootstrap() {
    return {
      mode: 'demo', baseCurrency: 'CNY', billingUnit: 'CNY', balanceCurrency: 'CNY', referenceCurrency: 'USD',
      timezone: this.config.timezone, syncLagSeconds: 38,
    };
  }

  async listMonitorGroups() {
    return this.monitorGroups
      .map((group) => ({ ...group }))
      .sort((left, right) => left.displayOrder - right.displayOrder || left.id - right.id);
  }

  async getMonitorSettings() {
    return { refreshIntervalSeconds: this.monitorRefreshIntervalSeconds || 30 };
  }

  async updateMonitorSettings(input) {
    this.monitorRefreshIntervalSeconds = input.refreshIntervalSeconds;
    return this.getMonitorSettings();
  }

  async listMonitorGroupCandidates() {
    return this.monitorGroups.map((group) => ({
      sourceGroupId: group.sourceGroupId,
      name: group.name,
      platform: 'openai',
      status: 'active',
      groupMultiplier: group.groupMultiplier,
      sortOrder: group.displayOrder,
      defaultModel: group.modelLabel,
      catalogSyncedAt: group.lastObservedAt,
      requests: 1200 + group.sourceGroupId * 310,
      lastUsedAt: group.lastObservedAt,
      latestModel: group.modelLabel,
    }));
  }

  async upsertSourceGroupCatalog(groups) {
    return groups.length;
  }

  async createMonitorGroup(input) {
    if (this.monitorGroups.some((group) => Number(group.sourceGroupId) === Number(input.sourceGroupId))) {
      throw Object.assign(new Error('source group is already configured'), { statusCode: 409 });
    }
    const group = {
      id: Math.max(0, ...this.monitorGroups.map((item) => item.id)) + 1,
      ...input,
      status: 'unknown',
      availableAccountCount: 0,
      totalAccountCount: 0,
      groupMultiplier: null,
      configuredGroupMultiplier: null,
      userMultiplier: null,
      effectiveMultiplier: null,
      averageLatencyMs: null,
      averagePingLatencyMs: null,
      availabilityPercent: null,
      lastObservedAt: null,
    };
    this.monitorGroups.push(group);
    return { ...group };
  }

  async updateMonitorGroup(id, input) {
    const group = this.monitorGroups.find((item) => Number(item.id) === Number(id));
    if (!group) throw Object.assign(new Error('monitor group not found'), { statusCode: 404 });
    const duplicate = this.monitorGroups.find((item) => item.id !== group.id && Number(item.sourceGroupId) === Number(input.sourceGroupId));
    if (duplicate) throw Object.assign(new Error('source group is already configured'), { statusCode: 409 });
    Object.assign(group, input);
    return { ...group };
  }

  async getPublicMonitorDashboard() {
    return {
      generatedAt: new Date().toISOString(),
      refreshIntervalSeconds: (await this.getMonitorSettings()).refreshIntervalSeconds,
      groups: this.monitorGroups
        .filter((group) => group.enabled)
        .sort((left, right) => left.displayOrder - right.displayOrder || left.id - right.id)
        .map(({
          availableAccountCount: _availableAccountCount,
          totalAccountCount: _totalAccountCount,
          groupMultiplier: _groupMultiplier,
          userMultiplier: _userMultiplier,
          effectiveMultiplier: _effectiveMultiplier,
          ...group
        }) => ({
          ...group,
          history: demoMonitorHistory(group),
        })),
    };
  }

  async getSummary() {
    const revenue = trend.reduce((sum, item) => sum + item.revenue, 0);
    const userChargeCny = trend.reduce((sum, item) => sum + item.userChargeCny, 0);
    const allocatedCost = trend.reduce((sum, item) => sum + item.allocatedCost, 0);
    const effectiveCostCny = trend.reduce((sum, item) => sum + item.effectiveCostCny, 0);
    const grossProfit = revenue - effectiveCostCny;
    return {
      cash: { received: 1384.2, rechargeReceived: 1384.2, totalReceived: 1384.2, refunds: 24.1, gatewayFees: 8.42, procurementSpend: 188.5, netInflow: 1163.18 },
      operations: {
        consumptionCny: userChargeCny, revenue: userChargeCny, revenueCny: userChargeCny, recognizedRevenueCny: userChargeCny, userChargeCny,
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

  reportableNonCashBalanceCredits() {
    const excludedUserIds = new Set(this.users
      .filter((user) => user.excludeFromBalanceStats)
      .map((user) => Number(user.id)));
    return this.nonCashBalanceCredits.filter((item) => !excludedUserIds.has(Number(item.sourceUserId)));
  }

  async getOverviewDashboard() {
    const summary = await this.getSummary();
    const rank = (key) => this.users
      .filter((item) => Number(item[key] || 0) > 0)
      .sort((left, right) => Number(right[key] || 0) - Number(left[key] || 0) || Number(left.id) - Number(right.id))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        email: item.email,
        username: item.username,
        tokens: Number(item.tokens || 0),
        requests: Number(item.requests || 0),
        cashPaidCny: Number(item.cashPaidCny || 0),
        userChargeCny: Number(item.userChargeCny || 0),
      }));
    const reportableNonCashBalanceCredits = this.reportableNonCashBalanceCredits();
    const giftBalanceCreditCny = reportableNonCashBalanceCredits.reduce((total, item) => total + Number(item.amountCny || 0), 0);
    const reportedBalanceUsers = this.users.filter((item) => (
      Number(item.balanceCny || 0) > 0 && !item.excludeFromBalanceStats
    ));

    return {
      generatedAt: new Date().toISOString(),
      summary,
      totals: {
        giftBalanceCreditCny,
        giftBalanceCreditCount: reportableNonCashBalanceCredits.length,
        balanceCny: reportedBalanceUsers.reduce((total, item) => total + Number(item.balanceCny || 0), 0),
        balanceUserCount: reportedBalanceUsers.length,
      },
      rankings: {
        tokenUsage: rank('tokens'),
        cashRecharge: rank('cashPaidCny'),
        requestActivity: rank('requests'),
      },
    };
  }

  async getTrend({ preset = '7d', dailyStart, dailyEnd } = {}) {
    const rechargeEvents = this.cashTransactions
      .filter((item) => item.type === 'recharge' && item.direction === 'in')
      .map((item) => ({
        id: item.id,
        occurredAt: item.occurredAt,
        amountCny: Number(item.amount || 0),
        creditedCny: Number(item.creditedAmountCny || 0),
        paymentMethod: item.method,
        reference: item.reference,
      }));
    let visibleTrend = trend;
    if (preset === 'today') visibleTrend = trend.slice(-1);
    else if (preset === '7d') visibleTrend = trend.slice(-7);
    else if (preset === 'custom' && dailyStart && dailyEnd) {
      visibleTrend = trend.filter((item) => item.day >= dailyStart && item.day <= dailyEnd);
    }
    return {
      items: visibleTrend.map((item, index) => ({
        ...item,
        rechargeCny: index === visibleTrend.length - 1 ? rechargeEvents.reduce((sum, event) => sum + event.amountCny, 0) : 0,
      })),
      rechargeEvents: preset === 'today' ? rechargeEvents : [],
    };
  }
  async getUsageBreakdown({ page = 1, pageSize = 20, sort = 'userChargeCny', direction = 'desc' } = {}) {
    const sortable = new Set(['userChargeCny', 'requests', 'tokens', 'bookedCostCny', 'bookedProfitCny']);
    const key = sortable.has(sort) ? sort : 'userChargeCny';
    const order = direction === 'asc' ? 1 : -1;
    const sorted = [...models].sort((left, right) => (
      order * (Number(left[key] || 0) - Number(right[key] || 0))
      || String(left.name || '').localeCompare(String(right.name || ''))
    ));
    return pageResult(sorted, page, pageSize);
  }

  async listUsageEvents({ search = '', page = 1, pageSize = 20 } = {}) {
    const events = Array.from({ length: 48 }, (_, index) => {
      const user = this.users[index % this.users.length];
      const account = this.accounts[index % this.accounts.length];
      const model = models[index % models.length];
      const inputTokens = 12_000 + index * 730;
      const outputTokens = 1_200 + index * 91;
      const cacheCreationTokens = index % 3 ? 0 : 1_800 + index * 37;
      const cacheReadTokens = 5_000 + index * 250;
      const userChargeCny = Number((model.userChargeCny / Math.max(1, model.requests) * (1 + (index % 5) * 0.2)).toFixed(6));
      const fixedCost = account.costMode === 'fixed_purchase';
      return {
        sourceUsageId: 900_000 + index,
        requestId: `demo-request-${900_000 + index}`,
        occurredAt: new Date(Date.now() - index * 27 * 60_000).toISOString(),
        userId: user.id,
        email: user.email,
        username: user.username,
        accountId: account.id,
        accountName: account.name,
        groupId: 1 + (index % 4),
        channelId: 1 + (index % 3),
        model: model.name,
        requestedModel: model.name,
        upstreamModel: index % 4 ? '' : model.name,
        billingMode: 'token',
        billingType: 0,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        tokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        durationMs: 7_200 + index * 130,
        firstTokenMs: 420 + index * 11,
        standardCostUsdReference: Number((model.tokenListValueUsd / Math.max(1, model.requests)).toFixed(6)),
        userChargeCny,
        recognizedRevenueCny: userChargeCny,
        costMode: account.costMode || 'fixed_purchase',
        basisMode: 'revenue_backsolve',
        costStatus: fixedCost ? 'fixed_cost' : 'priced',
        calculatedCostCny: fixedCost ? null : Number((userChargeCny * 0.72).toFixed(6)),
        sourceSellingMultiplier: fixedCost ? null : 1,
        upstreamMultiplier: fixedCost ? null : 0.72,
        cnyPerReferenceUnit: null,
        upstreamMultiplierSource: fixedCost ? '' : 'manual_rule',
        rateObservationId: null,
        costSnapshotOrigin: 'live_sync',
        costSnapshotFinalized: index > 3,
      };
    });
    const term = String(search || '').trim().toLowerCase();
    const filtered = term ? events.filter((event) => (
      `${event.sourceUsageId} ${event.requestId} ${event.email} ${event.username} ${event.accountName} ${event.model} ${event.requestedModel} ${event.upstreamModel}`
        .toLowerCase().includes(term)
    )) : events;
    return pageResult(filtered, page, pageSize);
  }

  async listUsers({
    search = '', page = 1, pageSize = 20, sort = 'userChargeCny', direction = 'desc',
    balanceScope = 'all', consumptionOnly = false,
  } = {}) {
    const sortable = new Set([
      'cashPaidCny','adminCreditCny','adminDeductionCny','balanceCny',
      'userChargeCny','requests','tokens','bookedCostCny','bookedProfitCny',
    ]);
    const key = sortable.has(sort) ? sort : 'userChargeCny';
    const order = direction === 'asc' ? 1 : -1;
    const filtered = this.users
      .filter((item) => `${item.email} ${item.username}`.toLowerCase().includes(search.toLowerCase()))
      .filter((item) => !consumptionOnly || Number(item.userChargeCny || 0) > 0)
      .filter((item) => (
        balanceScope === 'all'
        || (balanceScope === 'reported' && Number(item.balanceCny || 0) > 0 && !item.excludeFromBalanceStats)
        || (balanceScope === 'whitelist' && item.excludeFromBalanceStats)
      ))
      .sort((left, right) => (
        order * (Number(left[key] || 0) - Number(right[key] || 0))
        || Number(left.id) - Number(right.id)
      ));
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async getUserDetails({ userId, recharge, usage } = {}) {
    const user = this.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw Object.assign(new Error('user not found; run synchronization first'), { statusCode: 404 });
    const userRecharges = this.cashTransactions
      .filter((item) => item.type === 'recharge' && item.direction === 'in' && Number(item.sourceUserId || 1) === Number(userId))
      .map((item) => ({
        id: item.id, occurredAt: item.occurredAt, amountCny: Number(item.amount || 0),
        creditedCny: Number(item.creditedAmountCny || 0), paymentMethod: item.method,
        reference: item.reference, status: item.status,
      }));
    const userUsage = Array.from({ length: Math.min(32, Math.max(1, Math.round(user.requests / 8))) }, (_, index) => ({
      sourceUsageId: Number(`${user.id}${index + 1}`),
      occurredAt: new Date(Date.now() - index * 78 * 60_000).toISOString(),
      model: index % 2 ? 'gpt-5.6-sol' : 'claude-opus-4-8',
      requestedModel: index % 2 ? 'gpt-5.6-sol' : 'claude-opus-4-8',
      upstreamModel: '',
      accountId: 2745 + (index % 3),
      userChargeCny: +(user.userChargeCny / Math.max(1, Math.round(user.requests / 8))).toFixed(2),
      tokens: Math.round(user.tokens / Math.max(1, Math.round(user.requests / 8))),
      durationMs: 14200 + index * 110,
    }));
    const pageItems = (items, page) => ({
      items: items.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
      total: items.length, page: page.page, pageSize: page.pageSize,
    });
    return {
      user: {
        id: user.id, email: user.email, username: user.username, tags: user.tags, status: 'active',
        balanceCny: user.balanceCny, consumptionCny: user.userChargeCny, requests: user.requests, tokens: user.tokens,
        rechargeCny: user.cashPaidCny, creditedCny: user.creditedCny,
        adminCreditCny: user.adminCreditCny || 0, adminDeductionCny: user.adminDeductionCny || 0,
      },
      trend: trend.slice(-7).map((item, index) => ({
        day: item.day,
        consumptionCny: +(user.userChargeCny * (0.08 + (index % 4) * 0.04)).toFixed(2),
        rechargeCny: index === 6 ? userRecharges.reduce((sum, row) => sum + row.amountCny, 0) : 0,
      })),
      recharges: pageItems(userRecharges, recharge),
      usage: pageItems(userUsage, usage),
    };
  }

  async setUserBalanceStatsWhitelist(userId, input) {
    const user = this.users.find((item) => Number(item.id) === Number(userId));
    if (!user) throw Object.assign(new Error('user not found'), { statusCode: 404 });
    user.excludeFromBalanceStats = Boolean(input.excludeFromBalanceStats);
    return { id: user.id, email: user.email, username: user.username, excludeFromBalanceStats: user.excludeFromBalanceStats };
  }

  async setBulkUserBalanceStatsWhitelist(input) {
    const ids = new Set(input.userIds.map(Number));
    this.users.forEach((user) => {
      if (ids.has(Number(user.id))) user.excludeFromBalanceStats = Boolean(input.excludeFromBalanceStats);
    });
    return { userIds: input.userIds, updated: input.userIds.length, excludeFromBalanceStats: Boolean(input.excludeFromBalanceStats) };
  }

  async listAccounts({ search = '', scope = 'current', page = 1, pageSize = 20 } = {}) {
    const filtered = this.accounts.filter((item) => {
      const deleted = Boolean(item.sourceDeletedAt);
      const matchesScope = scope === 'all'
        || (scope === 'deleted' && deleted)
        || (scope === 'current' && !deleted && item.status === 'active');
      return matchesScope && `${item.name} ${item.platform} ${item.supplier}`.toLowerCase().includes(search.toLowerCase());
    });
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
  }

  async listAccountCostPeriods({ accountId, page = 1, pageSize = 10 } = {}) {
    const periods = this.accountCostPeriods
      .filter((item) => Number(item.accountId) === Number(accountId))
      .sort((left, right) => new Date(right.effectiveFrom) - new Date(left.effectiveFrom) || right.id - left.id)
      .map((item) => ({
        ...item,
        totalCost: Number(item.baseAmount || item.originalAmount || 0)
          + Number(item.feeAmount || 0) + Number(item.taxAmount || 0),
        costProfile: this.costProfiles.find((profile) => Number(profile.id) === Number(item.costProfileId))?.name || '未绑定模板',
        hasStarted: new Date(item.effectiveFrom).getTime() <= Date.now(),
      }));
    return pageResult(periods, page, pageSize);
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
      const grossProfit = item.userChargeCny - item.effectiveCostCny;
      return {
        ...item,
        platforms: [...item.platforms],
        revenue: item.userChargeCny,
        revenueCny: item.userChargeCny,
        recognizedRevenueCny: item.userChargeCny,
        purchaseAllocatedCostCny: item.purchaseSpend,
        fullyLoadedCostCny: item.effectiveCostCny, bookedCostCny: item.effectiveCostCny,
        grossProfit,
        grossProfitCny: grossProfit, bookedProfitCny: grossProfit,
        grossMargin: item.userChargeCny ? grossProfit / item.userChargeCny : null,
      };
    }).sort((a, b) => b.purchaseSpend - a.purchaseSpend || b.userChargeCny - a.userChargeCny);

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

  async listPurchaseCatalog() {
    const supplierByKey = new Map();
    const batches = new Map();
    const collect = (supplier, purchaseBatch = '') => {
      const supplierName = String(supplier || '').trim();
      const batchName = String(purchaseBatch || '').trim();
      if (!supplierName) return;
      const key = supplierName.toLowerCase();
      if (!supplierByKey.has(key)) supplierByKey.set(key, supplierName);
      if (batchName) batches.set(`${key}\u0000${batchName}`, {
        supplier: supplierByKey.get(key),
        purchaseBatch: batchName,
      });
    };
    this.supplierConnections.forEach((item) => collect(item.supplierName));
    this.accounts.forEach((item) => collect(item.supplier, item.purchaseBatch));
    this.accountCostPeriods.forEach((item) => collect(item.supplier, item.purchaseBatch));
    const supplierKeys = this.supplierConnections.flatMap((connection) => {
      const detail = this.supplierConnectionDetails.get(Number(connection.id));
      if (!detail || !['sub2api','newapi'].includes(connection.detectedAdapterType || connection.adapterType)) return [];
      return detail.keys
        .filter((key) => !key.removedAt && key.status === 'active')
        .flatMap((key) => {
          const links = key.accountLinks?.length ? key.accountLinks : [null];
          return links.map((link) => ({
            id:key.id,
            supplier:connection.supplierName,
            connectionId:connection.id,
            connectionName:connection.name,
            adapterType:connection.detectedAdapterType || connection.adapterType,
            name:key.name,
            maskedKey:key.maskedKey,
            groupName:key.groupName,
            rateMultiplier:key.rateMultiplier,
            checkStatus:key.lastCheckStatus,
            checkedAt:key.lastCheckAt,
            accountId:link?.accountId || null,
          }));
        });
    });
    return {
      suppliers: [...supplierByKey.values()].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      batches: [...batches.values()].sort((left, right) => (
        left.supplier.localeCompare(right.supplier, 'zh-CN')
        || left.purchaseBatch.localeCompare(right.purchaseBatch, 'zh-CN')
      )),
      supplierKeys,
    };
  }

  async listSupplierConnections({ search = '' } = {}) {
    const term = String(search || '').trim().toLowerCase();
    return {
      items: this.supplierConnections
        .filter((item) => `${item.supplierName} ${item.name} ${item.baseUrl}`.toLowerCase().includes(term))
        .map((item) => copySupplierConnection(item)),
    };
  }

  async getSupplierConnection(connectionId, { includeCiphertext = false } = {}) {
    const connection = this.supplierConnections.find((item) => Number(item.id) === Number(connectionId));
    if (!connection) throw Object.assign(new Error('supplier connection not found'), { statusCode: 404 });
    return copySupplierConnection(connection, { includeCiphertext });
  }

  supplierDetail(connectionId) {
    const detail = this.supplierConnectionDetails.get(Number(connectionId));
    if (!detail) throw Object.assign(new Error('supplier connection details not found'), { statusCode: 404 });
    return detail;
  }

  refreshSupplierConnectionStats(connection) {
    const detail = this.supplierDetail(connection.id);
    const visibleKeys = detail.keys.filter((key) => !key.removedAt);
    connection.keyCount = visibleKeys.length;
    connection.activeKeyCount = visibleKeys.filter((key) => key.status === 'active').length;
    connection.failedKeyCount = visibleKeys.filter((key) => key.lastCheckStatus === 'failed').length;
    connection.openAlertCount = detail.alerts.filter((alert) => alert.status === 'open').length;
  }

  nextSupplierKeyId() {
    return Math.max(0, ...[...this.supplierConnectionDetails.values()]
      .flatMap((detail) => detail.keys.map((key) => Number(key.id) || 0))) + 1;
  }

  findSupplierKey(keyId) {
    for (const connection of this.supplierConnections) {
      const detail = this.supplierConnectionDetails.get(Number(connection.id));
      const key = detail?.keys.find((item) => Number(item.id) === Number(keyId));
      if (key) return { connection, detail, key };
    }
    return null;
  }

  createSupplierDetail(connection) {
    const keyId = this.nextSupplierKeyId();
    const balance = finiteNumber(connection.balance);
    return {
      keys: [{
        id: keyId,
        externalId: `demo-${connection.id}-key`,
        name: connection.name || `连接 #${connection.id}`,
        maskedKey: 'sk-demo...key',
        status: 'active',
        groupName: '演示分组',
        rateMultiplier: null,
        quotaTotal: null,
        quotaUsed: null,
        quotaRemaining: null,
        quotaCurrency: connection.balanceCurrency || 'USD',
        lastCheckStatus: 'pending',
        lastCheckMethod: '',
        lastCheckAt: null,
        accountLinks: [],
      }],
      balances: balance === null ? [] : [{ balance, currency: connection.balanceCurrency || 'USD', observedAt: new Date().toISOString() }],
      checks: [],
      alerts: [],
    };
  }

  async createSupplierConnection(input, credentialsCiphertext) {
    if (this.supplierConnections.some((item) => item.supplierName === input.supplierName && item.name === input.name)) {
      throw Object.assign(new Error('supplier connection already exists'), { statusCode: 409 });
    }
    const sameSupplier = this.supplierConnections.find((item) => item.supplierName === input.supplierName);
    const balance = input.adapterType === 'openai_compatible' ? finiteNumber(input.credentials?.balance) : null;
    const now = new Date().toISOString();
    const connection = {
      id: Math.max(0, ...this.supplierConnections.map((item) => Number(item.id) || 0)) + 1,
      supplierId: sameSupplier?.supplierId || Math.max(0, ...this.supplierConnections.map((item) => Number(item.supplierId) || 0)) + 1,
      supplierName: input.supplierName,
      name: input.name,
      adapterType: input.adapterType,
      detectedAdapterType: '',
      baseUrl: input.baseUrl,
      authMode: input.authMode,
      credentialLabel: input.credentialLabel || '',
      credentialsConfigured: Boolean(credentialsCiphertext),
      credentialsCiphertext: credentialsCiphertext || '',
      enabled: input.enabled,
      inventoryIntervalSeconds: input.inventoryIntervalSeconds ?? Number(input.inventoryIntervalMinutes || 10) * 60,
      inventoryIntervalMinutes: Math.ceil((input.inventoryIntervalSeconds ?? Number(input.inventoryIntervalMinutes || 10) * 60) / 60),
      activeCheckEnabled: input.activeCheckEnabled,
      activeCheckLimit: input.activeCheckLimit,
      lowBalanceThreshold: input.lowBalanceThreshold,
      balanceCurrency: input.credentials?.balanceCurrency || input.balanceCurrency,
      qualityMonitorMode: input.qualityMonitorMode || 'passive',
      balance,
      connectionStatus: input.enabled ? 'pending' : 'disabled',
      keyCount: 0,
      activeKeyCount: 0,
      failedKeyCount: 0,
      openAlertCount: 0,
      lastSyncAt: null,
      lastSuccessAt: null,
      nextSyncAt: input.enabled ? now : null,
      consecutiveFailures: 0,
      lastError: '',
    };
    this.supplierConnections.push(connection);
    this.supplierConnectionDetails.set(connection.id, this.createSupplierDetail(connection));
    this.refreshSupplierConnectionStats(connection);
    return copySupplierConnection(connection);
  }

  async updateSupplierConnection(connectionId, input, credentialsCiphertext) {
    const connection = this.supplierConnections.find((item) => Number(item.id) === Number(connectionId));
    if (!connection) throw Object.assign(new Error('supplier connection not found'), { statusCode: 404 });
    const duplicate = this.supplierConnections.find((item) => (
      Number(item.id) !== Number(connectionId) && item.supplierName === input.supplierName && item.name === input.name
    ));
    if (duplicate) throw Object.assign(new Error('supplier connection already exists'), { statusCode: 409 });
    const supplier = this.supplierConnections.find((item) => Number(item.id) !== Number(connectionId) && item.supplierName === input.supplierName);
    Object.assign(connection, {
      supplierId: supplier?.supplierId || connection.supplierId,
      supplierName: input.supplierName,
      name: input.name,
      adapterType: input.adapterType,
      detectedAdapterType: '',
      baseUrl: input.baseUrl,
      authMode: input.authMode,
      credentialLabel: input.credentialLabel || '',
      enabled: input.enabled,
      inventoryIntervalSeconds: input.inventoryIntervalSeconds ?? Number(input.inventoryIntervalMinutes || 10) * 60,
      inventoryIntervalMinutes: Math.ceil((input.inventoryIntervalSeconds ?? Number(input.inventoryIntervalMinutes || 10) * 60) / 60),
      activeCheckEnabled: input.activeCheckEnabled,
      activeCheckLimit: input.activeCheckLimit,
      lowBalanceThreshold: input.lowBalanceThreshold,
      balanceCurrency: input.credentials?.balanceCurrency || input.balanceCurrency,
      qualityMonitorMode: input.qualityMonitorMode || connection.qualityMonitorMode || 'passive',
      connectionStatus: input.enabled ? 'pending' : 'disabled',
      nextSyncAt: input.enabled ? new Date().toISOString() : null,
      lastError: '',
      consecutiveFailures: 0,
    });
    if (credentialsCiphertext) {
      connection.credentialsCiphertext = credentialsCiphertext;
      connection.credentialsConfigured = true;
    }
    if (input.adapterType === 'openai_compatible' && finiteNumber(input.credentials?.balance) !== null) {
      connection.balance = finiteNumber(input.credentials.balance);
    }
    const detail = this.supplierDetail(connection.id);
    if (input.adapterType === 'openai_compatible' && detail.keys[0]) {
      const key = detail.keys[0];
      key.name = input.credentials?.keyName || key.name;
      key.rateMultiplier = input.credentials?.rateMultiplier ?? key.rateMultiplier;
      key.quotaCurrency = input.credentials?.balanceCurrency || input.balanceCurrency;
    }
    this.refreshSupplierConnectionStats(connection);
    return copySupplierConnection(connection);
  }

  async updateSupplierConnectionAccessToken(connectionId, credentialsCiphertext) {
    const connection = this.supplierConnections.find((item) => Number(item.id) === Number(connectionId));
    if (connection) connection.credentialsCiphertext = credentialsCiphertext;
  }

  async syncSupplierConnection(connectionId) {
    const connection = this.supplierConnections.find((item) => Number(item.id) === Number(connectionId));
    if (!connection) throw Object.assign(new Error('supplier connection not found'), { statusCode: 404 });
    if (!connection.enabled) return { ok: false, status: 'disabled' };
    const detail = this.supplierDetail(connection.id);
    const checkedAt = new Date().toISOString();
    const activeKeys = detail.keys.filter((key) => key.status === 'active' && !key.removedAt).slice(0, connection.activeCheckLimit);
    if (connection.activeCheckEnabled) {
      for (const key of activeKeys) {
        key.lastCheckStatus = 'ok';
        key.lastCheckMethod = 'demo_read';
        key.lastCheckAt = checkedAt;
        detail.checks.unshift({
          id: `${checkedAt}:${key.id}`,
          keyId: key.id,
          keyName: key.name,
          maskedKey: key.maskedKey,
          status: 'ok',
          method: 'demo_read',
          httpStatus: 200,
          latencyMs: 12,
          errorCode: '',
          errorMessage: '',
          checkedAt,
        });
      }
      detail.checks.splice(100);
    }
    if (finiteNumber(connection.balance) !== null) {
      detail.balances.unshift({ balance: Number(connection.balance), currency: connection.balanceCurrency || 'USD', observedAt: checkedAt });
      detail.balances.splice(60);
    }
    connection.connectionStatus = 'ok';
    connection.detectedAdapterType = connection.adapterType === 'auto' ? 'sub2api' : connection.adapterType;
    connection.lastSyncAt = checkedAt;
    connection.lastSuccessAt = checkedAt;
    connection.nextSyncAt = new Date(Date.now() + Number(connection.inventoryIntervalSeconds || Number(connection.inventoryIntervalMinutes || 10) * 60) * 1000).toISOString();
    connection.consecutiveFailures = 0;
    connection.lastError = '';
    this.refreshSupplierConnectionStats(connection);
    return {
      ok: true,
      adapterType: connection.detectedAdapterType,
      keyCount: connection.keyCount,
      checked: connection.activeCheckEnabled ? activeKeys.length : 0,
    };
  }

  async getSupplierConnectionDetails(connectionId) {
    const connection = await this.getSupplierConnection(connectionId);
    const detail = copySupplierDetail(this.supplierDetail(connectionId));
    return {
      connection,
      keys: detail.keys.filter((key) => !key.removedAt && key.status === 'active'),
      balances: detail.balances,
      checks: detail.checks,
      alerts: detail.alerts,
      accounts: this.accounts.map((item) => ({ id:item.id,name:item.name,platform:item.platform,status:item.status })),
    };
  }

  qualityTarget(target) {
    return { ...target };
  }

  qualityObservation(observation) {
    return { ...observation, metadata: { ...(observation.metadata || {}) } };
  }

  async listSupplierQualityTargets(connectionId) {
    return {
      items: this.supplierQualityTargets
        .filter((target) => Number(target.connectionId) === Number(connectionId))
        .map((target) => this.qualityTarget(target)),
    };
  }

  async getSupplierQualityTargetContext(targetId) {
    const target = this.supplierQualityTargets.find((item) => Number(item.id) === Number(targetId));
    if (!target) throw Object.assign(new Error('supplier quality target not found'), { statusCode: 404 });
    const connection = this.supplierConnections.find((item) => Number(item.id) === Number(target.connectionId));
    return { ...this.qualityTarget(target), connection: copySupplierConnection(connection, { includeCiphertext: true }) };
  }

  async getSupplierKeyContext(keyId) {
    const match = this.findSupplierKey(keyId);
    if (!match) throw Object.assign(new Error('supplier key not found'), { statusCode: 404 });
    return {
      keyId: Number(keyId), externalKeyId: String(match.key.externalId), keyName: match.key.name || '',
      maskedKey: match.key.maskedKey || '', keyStatus: match.key.status, groupName: match.key.groupName || '',
      rateMultiplier: match.key.rateMultiplier, connection: copySupplierConnection(match.connection, { includeCiphertext: true }),
    };
  }

  async upsertSupplierQualityTarget(connectionId, input) {
    const key = this.supplierDetail(connectionId).keys.find((item) => Number(item.id) === Number(input.keyId));
    if (!key || key.removedAt) throw Object.assign(new Error('supplier key is not available for this connection'), { statusCode: 400 });
    const duplicate = this.supplierQualityTargets.find((item) => (
      Number(item.keyId) === Number(input.keyId) && item.model === input.model
    ));
    const target = duplicate || {
      id: Math.max(0, ...this.supplierQualityTargets.map((item) => Number(item.id) || 0)) + 1,
      connectionId: Number(connectionId), keyId: Number(input.keyId), externalKeyId: key.externalId,
      keyName: key.name, maskedKey: key.maskedKey, keyStatus: key.status, groupName: key.groupName,
      rateMultiplier: key.rateMultiplier,
    };
    Object.assign(target, {
      model: input.model, enabled: input.enabled, intervalSeconds: input.intervalSeconds,
      maxOutputTokens: input.maxOutputTokens,
      lastStatus: input.enabled ? (target.lastStatus === 'disabled' ? 'pending' : target.lastStatus) : 'disabled',
      lastError: input.enabled ? target.lastError : '',
    });
    if (!duplicate) this.supplierQualityTargets.push(target);
    return this.qualityTarget(target);
  }

  async updateSupplierQualityTarget(targetId, input) {
    const target = this.supplierQualityTargets.find((item) => Number(item.id) === Number(targetId));
    if (!target) throw Object.assign(new Error('supplier quality target not found'), { statusCode: 404 });
    const key = this.supplierDetail(target.connectionId).keys.find((item) => Number(item.id) === Number(input.keyId));
    if (!key || key.removedAt) throw Object.assign(new Error('supplier key is not available for this connection'), { statusCode: 400 });
    const duplicate = this.supplierQualityTargets.find((item) => (
      Number(item.id) !== Number(targetId) && Number(item.keyId) === Number(input.keyId) && item.model === input.model
    ));
    if (duplicate) throw Object.assign(new Error('this supplier key and model target already exists'), { statusCode: 409 });
    Object.assign(target, {
      keyId: Number(input.keyId), externalKeyId: key.externalId, keyName: key.name, maskedKey: key.maskedKey,
      keyStatus: key.status, groupName: key.groupName, rateMultiplier: key.rateMultiplier,
      model: input.model, enabled: input.enabled, intervalSeconds: input.intervalSeconds,
      maxOutputTokens: input.maxOutputTokens,
      lastStatus: input.enabled ? (target.lastStatus === 'disabled' ? 'pending' : target.lastStatus) : 'disabled',
      lastError: input.enabled ? target.lastError : '',
    });
    return this.qualityTarget(target);
  }

  async deleteSupplierQualityTarget(targetId) {
    const index = this.supplierQualityTargets.findIndex((item) => Number(item.id) === Number(targetId));
    if (index < 0) throw Object.assign(new Error('supplier quality target not found'), { statusCode: 404 });
    this.supplierQualityTargets.splice(index, 1);
    this.supplierQualityObservations = this.supplierQualityObservations.filter((item) => Number(item.targetId) !== Number(targetId));
    return { id: Number(targetId), deleted: true };
  }

  async recordSupplierQualityObservations(connectionId, observations = []) {
    let inserted = 0;
    for (const observation of observations) {
      const externalId = observation.externalObservationId || `${observation.sourceKind}:${observation.observedAt}`;
      if (this.supplierQualityObservations.some((item) => (
        Number(item.connectionId) === Number(connectionId)
        && item.sourceKind === observation.sourceKind
        && item.externalObservationId === externalId
      ))) continue;
      this.supplierQualityObservations.unshift({
        id: Math.max(0, ...this.supplierQualityObservations.map((item) => Number(item.id) || 0)) + 1,
        connectionId: Number(connectionId), keyId: observation.keyId || null,
        targetId: observation.targetId || null, externalObservationId: externalId,
        sourceKind: observation.sourceKind, model: observation.model || '',
        groupName: observation.groupName || '', status: ['ok', 'degraded'].includes(observation.status) ? observation.status : 'failed',
        availabilitySample: Boolean(observation.availabilitySample), httpStatus: Number(observation.httpStatus || 0),
        ttftMs: finiteNumber(observation.ttftMs), durationMs: finiteNumber(observation.durationMs),
        pingLatencyMs: finiteNumber(observation.pingLatencyMs), rateMultiplier: finiteNumber(observation.rateMultiplier),
        observedAt: observation.observedAt || new Date().toISOString(), metadata: { ...(observation.metadata || {}) },
      });
      inserted += 1;
    }
    return { inserted };
  }

  async recordSupplierQualityTargetResult(targetId, observation) {
    const target = this.supplierQualityTargets.find((item) => Number(item.id) === Number(targetId));
    if (!target) throw Object.assign(new Error('supplier quality target not found'), { statusCode: 404 });
    target.lastProbeAt = new Date().toISOString();
    target.lastStatus = ['ok', 'degraded'].includes(observation.status) ? observation.status : 'failed';
    target.lastError = observation.errorMessage || observation.errorCode || '';
    target.nextProbeAt = new Date(Date.now() + target.intervalSeconds * 1000).toISOString();
    await this.recordSupplierQualityObservations(target.connectionId, [{
      ...observation, targetId: Number(targetId), keyId: target.keyId,
      externalObservationId: `active:${targetId}:${target.lastProbeAt}`,
    }]);
    return this.qualityTarget(target);
  }

  supplierQualityScores() {
    const cutoff = Date.now() - 7 * 86_400_000;
    const keys = this.supplierConnections.flatMap((connection) => (
      this.supplierDetail(connection.id).keys.map((key) => ({
        id: Number(key.id),
        connectionId: Number(connection.id),
        name: key.name || '',
        maskedKey: key.maskedKey || '',
        groupName: key.groupName || '',
        status: key.status,
        removedAt: key.removedAt || null,
        rateMultiplier: key.rateMultiplier,
      }))
    ));
    return buildSupplierQualityScores({
      connections: this.supplierConnections.map((connection) => copySupplierConnection(connection)),
      observations: this.supplierQualityObservations.filter((item) => new Date(item.observedAt).getTime() >= cutoff),
      keys,
      targets: this.supplierQualityTargets,
      usageWeights: [],
    }).map((item) => ({
      ...item,
      metrics: {
        ...item.metrics,
        enabledTargetCount: this.supplierQualityTargets.filter((target) => (
          Number(target.connectionId) === Number(item.connection.id) && target.enabled
        )).length,
      },
    }));
  }

  async getSupplierQualityDashboard(connectionId) {
    const dashboard = this.supplierQualityScores()
      .find((item) => Number(item.connection.id) === Number(connectionId));
    if (!dashboard) throw Object.assign(new Error('supplier connection not found'), { statusCode: 404 });
    const observations = this.supplierQualityObservations
      .filter((item) => Number(item.connectionId) === Number(connectionId))
      .sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime());
    return {
      score: dashboard.score,
      metrics: dashboard.metrics,
      models: dashboard.models,
      observations: observations.slice(0, 100).map((item) => this.qualityObservation(item)),
    };
  }

  async listSupplierQualityOverview() {
    return { items: this.supplierQualityScores() };
  }

  async runSupplierQualityTarget(targetId) {
    return this.recordSupplierQualityTargetResult(targetId, {
      sourceKind: 'active_probe', model: this.supplierQualityTargets.find((item) => Number(item.id) === Number(targetId))?.model || '',
      status: 'ok', availabilitySample: true, httpStatus: 200, ttftMs: 860, durationMs: 1750,
      observedAt: new Date().toISOString(), metadata: { demo: true },
    });
  }

  async setSupplierKeyAccountLink(keyId, accountId, linked) {
    const match = this.findSupplierKey(keyId);
    if (!match) throw Object.assign(new Error('supplier key not found'), { statusCode: 404 });
    const account = this.accounts.find((item) => Number(item.id) === Number(accountId));
    if (!account) throw Object.assign(new Error('account not found'), { statusCode: 404 });
    if (linked) {
      for (const detail of this.supplierConnectionDetails.values()) {
        for (const key of detail.keys) {
          key.accountLinks = (key.accountLinks || []).filter((item) => Number(item.accountId) !== Number(accountId));
        }
      }
      match.key.accountLinks.push({ accountId: account.id, accountName: account.name });
      account.costMode = 'probe_multiplier';
      account.costType = 'probe_multiplier';
      account.supplier = match.connection.supplierName;
      account.purchaseBatch = '';
      account.supplierKeyId = Number(keyId);
      account.supplierKeyName = match.key.name || '';
      account.supplierKeyMasked = match.key.maskedKey || '';
      account.supplierKeyGroupName = match.key.groupName || '';
      account.supplierConnectionId = Number(match.connection.id);
      account.supplierConnectionName = match.connection.name;
      account.linkedSupplierName = match.connection.supplierName;
      account.probeStatus = match.key.lastCheckStatus || 'pending';
      account.upstreamMultiplier = match.key.rateMultiplier;
      account.upstreamMultiplierSource = match.key.rateMultiplier === null ? '' : 'supplier_direct_probe';
    } else {
      match.key.accountLinks = (match.key.accountLinks || []).filter((item) => Number(item.accountId) !== Number(accountId));
      if (Number(account.supplierKeyId) === Number(keyId)) {
        account.supplierKeyId = null;
        account.supplierKeyName = '';
        account.supplierKeyMasked = '';
        account.supplierKeyGroupName = '';
        account.supplierConnectionId = null;
        account.supplierConnectionName = '';
        account.linkedSupplierName = '';
        account.upstreamMultiplier = null;
        account.upstreamMultiplierSource = '';
      }
    }
    return {
      keyId: Number(keyId),
      accountId: Number(accountId),
      linked: Boolean(linked),
      connectionId: Number(match.connection.id),
      supplierName: match.connection.supplierName,
      keyName: match.key.name || match.key.maskedKey || '',
      costMode: linked ? 'probe_multiplier' : '',
      probeStatus: match.key.lastCheckStatus || 'pending',
      probeCheckedAt: match.key.lastCheckAt || null,
      adapterType: match.connection.detectedAdapterType || match.connection.adapterType,
    };
  }

  async getAccountProfitGuard(accountId) {
    const policy = this.accountProfitGuardPolicies.get(Number(accountId)) || {
      enabled: false, minimumMargin: 0, thresholdMode: 'margin', minimumSaleMultiplier: null, allowEmptyGroups: true,
      lastEvaluatedAt: null, lastActionAt: null, lastError: '',
    };
    const account = this.accounts.find((item) => Number(item.id) === Number(accountId));
    const match = account?.supplierKeyId ? this.findSupplierKey(account.supplierKeyId) : null;
    return {
      accountId: Number(accountId),
      policy: { ...policy },
      supplier: match ? {
        keyId: Number(account.supplierKeyId),
        keyName: match.key.name || match.key.maskedKey || '',
        supplierName: match.connection.supplierName || '',
        connectionName: match.connection.name || '',
        upstreamMultiplier: finiteNumber(match.key.rateMultiplier),
        removed: match.key.status !== 'active',
      } : null,
      events: [],
    };
  }

  async upsertAccountProfitGuard(accountId, input) {
    const account = this.accounts.find((item) => Number(item.id) === Number(accountId));
    if (!account) throw Object.assign(new Error('account not found'), { statusCode: 404 });
    const policy = {
      enabled: Boolean(input.enabled),
      minimumMargin: Number(input.minimumMargin || 0),
      thresholdMode: input.thresholdMode || 'margin',
      minimumSaleMultiplier: input.minimumSaleMultiplier === null || input.minimumSaleMultiplier === undefined
        ? null
        : Number(input.minimumSaleMultiplier),
      allowEmptyGroups: Boolean(input.allowEmptyGroups),
      lastEvaluatedAt: null,
      lastActionAt: null,
      lastError: '',
    };
    this.accountProfitGuardPolicies.set(Number(accountId), policy);
    return { accountId: Number(accountId), ...policy };
  }

  async getSub2ApiServiceAuthSettings({ includeCiphertext = false } = {}) {
    const result = { ...this.sub2ApiServiceAuthSettings };
    if (!includeCiphertext) delete result.credentialsCiphertext;
    return result;
  }

  async updateSub2ApiServiceAuthSettings(input, credentialsCiphertext, actor = 'admin') {
    Object.assign(this.sub2ApiServiceAuthSettings, {
      enabled:Boolean(input.enabled),
      email:input.email || '',
      credentialsCiphertext:credentialsCiphertext || '',
      credentialsConfigured:Boolean(credentialsCiphertext),
      lastAuthenticatedAt:null,
      tokenExpiresAt:null,
      lastError:'',
      updatedBy:actor,
      updatedAt:new Date().toISOString(),
    });
    return this.getSub2ApiServiceAuthSettings();
  }

  async recordSub2ApiServiceAuthResult({ lastAuthenticatedAt = null, tokenExpiresAt = null, lastError = '' }) {
    Object.assign(this.sub2ApiServiceAuthSettings, {
      lastAuthenticatedAt:lastAuthenticatedAt || this.sub2ApiServiceAuthSettings.lastAuthenticatedAt,
      tokenExpiresAt:lastAuthenticatedAt ? tokenExpiresAt : null,
      lastError:String(lastError || ''),
      updatedAt:new Date().toISOString(),
    });
  }

  async getAlertNotificationSettings({ includeCiphertext = false } = {}) {
    const result = { ...this.alertNotificationSettings };
    if (!includeCiphertext) delete result.accessTokenCiphertext;
    return result;
  }

  async updateAlertNotificationSettings(input, accessTokenCiphertext, actor = 'admin') {
    Object.assign(this.alertNotificationSettings, {
      enabled:input.enabled,
      qqNumber:input.qqNumber,
      onebotEndpoint:input.onebotEndpoint,
      updatedBy:actor,
      updatedAt:new Date().toISOString(),
    });
    if (accessTokenCiphertext !== undefined) {
      this.alertNotificationSettings.accessTokenCiphertext = accessTokenCiphertext;
      this.alertNotificationSettings.accessTokenConfigured = Boolean(accessTokenCiphertext);
    }
    return this.getAlertNotificationSettings();
  }

  async listPendingSupplierAlertDeliveries(limit = 20) {
    const alerts = [];
    for (const connection of this.supplierConnections) {
      const detail = this.supplierConnectionDetails.get(Number(connection.id));
      for (const alert of detail?.alerts || []) {
        if (alert.status !== 'open') continue;
        const payloadHash = JSON.stringify([alert.severity,alert.title,alert.message,alert.details || {}]);
        if (this.supplierAlertDeliveries.get(alert.id)?.payloadHash === payloadHash) continue;
        alerts.push({
          ...alert,payloadHash,connectionName:connection.name,supplierName:connection.supplierName,
        });
      }
    }
    return alerts.slice(0,limit);
  }

  async recordSupplierAlertDelivery(alertId, payloadHash, { delivered, error = '' }) {
    this.supplierAlertDeliveries.set(Number(alertId), { payloadHash,delivered,error });
  }

  async acknowledgeSupplierAlert(alertId, actor = 'admin') {
    for (const connection of this.supplierConnections) {
      const detail = this.supplierConnectionDetails.get(Number(connection.id));
      const alert = detail?.alerts.find((item) => Number(item.id) === Number(alertId));
      if (!alert) continue;
      const acknowledgedAt = new Date().toISOString();
      alert.status = 'acknowledged';
      alert.acknowledgedAt = acknowledgedAt;
      alert.acknowledgedBy = actor;
      alert.lastSeenAt = acknowledgedAt;
      this.refreshSupplierConnectionStats(connection);
      return { id: Number(alert.id), status: alert.status, acknowledgedAt, acknowledgedBy: actor };
    }
    throw Object.assign(new Error('supplier alert not found'), { statusCode: 404 });
  }

  async listCashTransactions({ page = 1, pageSize = 20, search = '', scope = 'all' } = {}) {
    const term = String(search || '').trim().toLowerCase();
    const scoped = scope === 'recharge'
      ? this.cashTransactions.filter((item) => (
        item.type === 'recharge' || (item.type === 'refund' && item.orderType !== 'subscription')
      ))
      : this.cashTransactions;
    const filtered = term ? scoped.filter((item) => `${item.reference} ${item.type} ${item.method} ${item.party}`.toLowerCase().includes(term)) : scoped;
    const inflow = scoped.filter((item) => item.direction === 'in').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const rechargeReceived = scoped.filter((item) => item.direction === 'in' && item.type === 'recharge').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const outflow = scoped.filter((item) => item.direction === 'out').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const refunds = scoped.filter((item) => item.type === 'refund').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize,
      summary: { inflow, rechargeReceived, outflow, refunds, net: inflow - outflow, transactions: scoped.length },
    };
  }

  async listNonCashBalanceCredits({ page = 1, pageSize = 20 } = {}) {
    const items = this.reportableNonCashBalanceCredits()
      .slice()
      .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
    const paged = pageResult(items, page, pageSize);
    return {
      ...paged,
      summary: {
        amountCny: items.reduce((total, item) => total + Number(item.amountCny || 0), 0),
        events: items.length,
      },
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
    const profile = {
      id,
      ...input,
      costMode: input.costMode || (input.costType === 'free' ? 'free' : 'fixed_purchase'),
      basisMode: input.basisMode || 'revenue_backsolve',
      version: 1,
      accountCount: 0,
    };
    this.costProfiles.unshift(profile);
    return profile;
  }

  async createAccountCostPeriod(input) {
    const account = this.accounts.find((item) => Number(item.id) === Number(input.accountId));
    const selectedProfile = input.costProfileId
      ? this.costProfiles.find((item) => Number(item.id) === Number(input.costProfileId))
      : null;
    if ((selectedProfile?.costMode || account?.costMode) === 'free') {
      throw Object.assign(new Error('free accounts cannot have a CNY cost period'), { statusCode: 409 });
    }
    if ((selectedProfile?.costMode || account?.costMode) && (selectedProfile?.costMode || account?.costMode) !== 'fixed_purchase') {
      throw Object.assign(new Error('multiplier accounts use the account ledger rule instead of a fixed cost period'), { statusCode: 409 });
    }
    const id = Math.max(0, ...this.accountCostPeriods.map((period) => period.id)) + 1;
    const period = { id, ...input, status: 'active' };
    this.accountCostPeriods.push(period);
    if (account) {
      if (selectedProfile) {
        account.costType = selectedProfile.costType;
        account.costMode = selectedProfile.costMode;
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
      account.currentCostPeriodId = id;
      account.currentCostProfileId = input.costProfileId || null;
      account.currentOriginalAmount = Number(input.originalAmount);
      account.currentFeeAmount = Number(input.feeAmount || 0);
      account.currentTaxAmount = Number(input.taxAmount || 0);
      account.currentEffectiveFrom = input.effectiveFrom;
      account.currentEffectiveTo = input.effectiveTo;
      account.currentCostNotes = input.notes || '';
    }
    return period;
  }

  async getRuntimeDashboard() {
    return {
      queue: {
        available: true, enabled: true, mode: 'observe', workerCount: 4, activeWorkers: 1, idleWorkers: 3,
        queueSize: 32768, queueLength: 2, queueUsagePercent: 0.01, processed: 256, errors: 0,
        observedAt: new Date().toISOString(),
      },
      users: this.users.slice(0, 5).map((user, index) => ({
        id: user.id,
        email: user.email,
        username: user.username || '',
        maxConcurrency: index ? 100 : 2000,
        currentConcurrency: index ? 1 : 2,
        usagePercent: index ? 1 : 0.1,
        observedAt: new Date().toISOString(),
      })),
    };
  }

  async createBulkAccountCostPeriods(input, actor) {
    const periods = [];
    const strategy = input.allocationStrategy || 'equal';
    const costs = splitFixedCostCny(input.originalAmount, input.accountIds, strategy);
    const fees = splitFixedCostCny(input.feeAmount || 0, input.accountIds, strategy);
    const taxes = splitFixedCostCny(input.taxAmount || 0, input.accountIds, strategy);
    for (const [index, accountId] of input.accountIds.entries()) {
      periods.push(await this.createAccountCostPeriod({
        ...input,
        accountId,
        originalAmount: costs[index].amountCny,
        baseAmount: costs[index].amountCny,
        feeAmount: fees[index].amountCny,
        taxAmount: taxes[index].amountCny,
      }, actor));
    }
    return {
      accountIds: input.accountIds,
      created: periods.length,
      periods,
      allocatedTotalCny: Number(input.originalAmount) + Number(input.feeAmount || 0) + Number(input.taxAmount || 0),
    };
  }

  async updateAccountLedger(accountId, input) {
    const account = this.accounts.find((item) => Number(item.id) === Number(accountId));
    if (!account) throw Object.assign(new Error('account not found; run synchronization first'), { statusCode: 404 });
    const profile = input.costProfileId ? this.costProfiles.find((item) => Number(item.id) === Number(input.costProfileId)) : null;
    if (input.costProfileId && !profile) throw Object.assign(new Error('cost profile not found'), { statusCode: 404 });
    const costMode = input.costMode || profile?.costMode || account.costMode || 'fixed_purchase';
    const hasActiveFixedCost = this.accountCostPeriods.some((period) => (
      Number(period.accountId) === Number(accountId)
      && period.status === 'active'
      && new Date(period.effectiveTo).getTime() > Date.now()
    ));
    if (['manual_multiplier', 'probe_multiplier', 'free'].includes(costMode) && hasActiveFixedCost) {
      throw Object.assign(new Error(
        costMode === 'free'
          ? 'free accounts cannot retain active CNY cost periods'
          : 'end the active fixed-cost period before enabling multiplier costs to avoid double-counting',
      ), { statusCode: 409 });
    }
    if (costMode === 'manual_multiplier' && !(input.upstreamMultiplier || profile?.variableMultiplier)) {
      throw Object.assign(new Error('manual_multiplier requires an account or template upstreamMultiplier'), { statusCode: 400 });
    }
    if (input.basisMode === 'reference_cny' && !(input.cnyPerReferenceUnit || profile?.cnyPerReferenceUnit)) {
      throw Object.assign(new Error('reference_cny requires an account or template cnyPerReferenceUnit'), { statusCode: 400 });
    }
    account.costProfileId = input.costProfileId;
    account.costType = profile?.costType || (costMode === 'free' ? 'free' : account.costType);
    account.costMode = costMode;
    account.basisMode = input.basisMode || account.basisMode || 'revenue_backsolve';
    account.upstreamMultiplier = input.upstreamMultiplier || profile?.variableMultiplier || null;
    account.cnyPerReferenceUnit = input.cnyPerReferenceUnit || profile?.cnyPerReferenceUnit || null;
    account.supplier = input.supplier;
    account.purchaseBatch = input.purchaseBatch;
    account.tags = input.tags;
    return { ...account };
  }

  async updateAccountCostPeriod(periodId, input) {
    const period = this.accountCostPeriods.find((item) => Number(item.id) === Number(periodId));
    if (!period) throw Object.assign(new Error('account cost period not found'), { statusCode: 404 });
    if (new Date(period.effectiveFrom).getTime() <= Date.now() && !input.correctionReason) {
      throw Object.assign(new Error('started purchase costs require a correctionReason so historical profit changes are explicit'), { statusCode: 409 });
    }
    const beforeTotal = Number(period.baseAmount || period.originalAmount || 0)
      + Number(period.feeAmount || 0) + Number(period.taxAmount || 0);
    Object.assign(period, input);
    const account = this.accounts.find((item) => Number(item.id) === Number(period.accountId));
    if (account) {
      if (input.costProfileId) {
        const profile = this.costProfiles.find((item) => Number(item.id) === Number(input.costProfileId));
        if (!profile) throw Object.assign(new Error('cost profile not found'), { statusCode: 404 });
        if (profile.costMode !== 'fixed_purchase') throw Object.assign(new Error('only fixed_purchase profiles can have a CNY cost period'), { statusCode: 409 });
        account.costType = profile.costType;
        account.costMode = profile.costMode;
        account.costProfileId = profile.id;
      }
      const afterTotal = Number(period.baseAmount || period.originalAmount || 0)
        + Number(period.feeAmount || 0) + Number(period.taxAmount || 0);
      account.periodCost = +(Number(account.periodCost || 0) - beforeTotal + afterTotal).toFixed(2);
      account.purchaseAllocatedCostCny = account.periodCost;
      account.effectiveCostCny = account.periodCost;
      account.fullyLoadedCost = account.periodCost;
      account.fullyLoadedCostCny = account.periodCost;
      account.bookedCostCny = account.periodCost;
      account.grossProfit = +(Number(account.revenue || 0) - account.periodCost).toFixed(2);
      account.grossProfitCny = account.grossProfit;
      account.bookedProfitCny = account.grossProfit;
      account.grossMargin = account.revenue ? +(account.grossProfit / account.revenue).toFixed(4) : null;
      account.supplier = input.supplier;
      account.purchaseBatch = input.purchaseBatch;
      if (Array.isArray(input.tags)) account.tags = input.tags;
      account.currentOriginalAmount = Number(input.originalAmount);
      account.currentFeeAmount = Number(input.feeAmount || 0);
      account.currentTaxAmount = Number(input.taxAmount || 0);
      account.currentEffectiveFrom = input.effectiveFrom;
      account.currentEffectiveTo = input.effectiveTo;
      account.currentCostNotes = input.notes || '';
    }
    return { ...period };
  }
}
