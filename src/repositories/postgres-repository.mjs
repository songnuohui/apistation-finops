import { inTransaction } from '../db.mjs';

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

export function effectiveCostCny(costType, ignoredReferenceCost, purchaseAllocatedCostCny) {
  const normalizedType = String(costType || 'unconfigured').toLowerCase();
  const purchaseCost = number(purchaseAllocatedCostCny === undefined ? ignoredReferenceCost : purchaseAllocatedCostCny);
  if (normalizedType === 'free') return 0;
  return purchaseCost;
}

export function effectiveCostSql(costTypeExpression, ignoredReferenceExpression, purchaseCostExpression) {
  return `CASE LOWER(COALESCE(${costTypeExpression}, 'unconfigured'))
    WHEN 'free' THEN 0
    ELSE ${purchaseCostExpression}
  END`;
}

export const SYNC_SOURCE_LABELS = Object.freeze({
  usage_logs: '用量与扣费',
  payment_orders: '充值与退款',
  redeem_codes: '兑换码与人工调账',
  user_affiliate_ledger: '邀请返利额度',
  payment_audit_logs: '支付审计',
  user_subscriptions: '用户订阅',
  credit_reconciliation: '额度对账',
});

export const REQUIRED_SYNC_SOURCES = Object.freeze(Object.keys(SYNC_SOURCE_LABELS));

function pageResult(rows, page, pageSize) {
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { items: rows.map(({ total_count, ...row }) => row), total, page, pageSize };
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export class PostgresRepository {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.schema = `"${config.finopsSchema}"`;
  }

  async getBootstrap() {
    const sync = await this.getSyncState();
    return {
      mode: 'database',
      baseCurrency: 'CNY',
      billingUnit: 'CNY',
      balanceCurrency: 'CNY',
      referenceCurrency: 'USD',
      timezone: this.config.timezone,
      syncLagSeconds: sync.lagSeconds,
    };
  }

  async getSummary({ start, end }) {
    const usage = await this.pool.query(`
      WITH recognition AS (
        SELECT source_usage_id,COALESCE(SUM(allocated_credit),0) AS allocated_credit
        FROM ${this.schema}.revenue_recognition
        GROUP BY source_usage_id
      )
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(input_tokens),0) AS input_tokens,
             COALESCE(SUM(output_tokens),0) AS output_tokens,
             COALESCE(SUM(cache_creation_tokens + cache_read_tokens),0) AS cache_tokens,
             COUNT(DISTINCT source_user_id) FILTER (WHERE source_user_id <> 0) AS active_users,
             COUNT(DISTINCT source_account_id) FILTER (WHERE source_account_id <> 0) AS active_accounts,
             COALESCE(AVG(duration_ms),0) AS average_latency_ms,
             COALESCE(SUM(user_charge_cny),0) AS user_charge_cny,
             COALESCE(SUM(recognized_revenue_cny),0) AS recognized_revenue_cny,
             COALESCE(SUM(GREATEST(user_charge_cny-COALESCE(recognition.allocated_credit,0),0))
               FILTER (WHERE revenue_recognition_status IN ('unallocated','partial') AND user_charge_cny>0),0) AS pending_revenue_cny,
             COUNT(*) FILTER (WHERE revenue_recognition_status IN ('unallocated','partial') AND user_charge_cny>0) AS pending_usage_count,
             COALESCE(SUM(standard_cost_usd_reference),0) AS token_list_value_usd
      FROM ${this.schema}.fact_usage_events
      LEFT JOIN recognition USING(source_usage_id)
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const cash = await this.pool.query(`
      SELECT COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND transaction_type='recharge' AND status <> 'void'),0) AS received,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND transaction_type='subscription_purchase' AND status <> 'void'),0) AS subscription_received,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type='refund' AND status <> 'void'),0) AS refunds,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type='gateway_fee'),0) AS gateway_fees,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type IN ('account_purchase','supplier_topup','subscription_renewal')),0) AS procurement_spend
      FROM ${this.schema}.cash_transactions
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const costs = await this.pool.query(`
      WITH usage_by_account AS (
        SELECT source_account_id,
               COALESCE(SUM(recognized_revenue_cny),0) AS recognized_revenue_cny,
               COALESCE(SUM(user_charge_cny),0) AS user_charge_cny
        FROM ${this.schema}.fact_usage_events
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY source_account_id
      ), purchase_by_account AS (
        SELECT source_account_id,
               COALESCE(SUM((base_amount+fee_amount+tax_amount) *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(effective_to,$2)-GREATEST(effective_from,$1))) /
                 NULLIF(EXTRACT(EPOCH FROM effective_to-effective_from),0)),0) AS purchase_allocated_cost_cny,
               COUNT(*) AS cost_record_count
        FROM ${this.schema}.account_cost_periods
        WHERE status='active' AND effective_from < $2 AND effective_to > $1
        GROUP BY source_account_id
      ), account_costs AS (
        SELECT COALESCE(u.source_account_id,p.source_account_id) AS source_account_id,
               COALESCE(u.recognized_revenue_cny,0) AS recognized_revenue_cny,
               COALESCE(u.user_charge_cny,0) AS user_charge_cny,
               COALESCE(p.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
               COALESCE(p.cost_record_count,0) AS cost_record_count,
               COALESCE(cp.cost_type,'unconfigured') AS cost_type,
               ${effectiveCostSql('cp.cost_type','0','COALESCE(p.purchase_allocated_cost_cny,0)')} AS effective_cost_cny
        FROM usage_by_account u
        FULL JOIN purchase_by_account p USING(source_account_id)
        LEFT JOIN ${this.schema}.dim_accounts a
          ON a.source_account_id=COALESCE(u.source_account_id,p.source_account_id)
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      )
      SELECT COALESCE(SUM(purchase_allocated_cost_cny),0) AS purchase_allocated_cost_cny,
             COALESCE(SUM(effective_cost_cny),0) AS effective_cost_cny,
             COUNT(*) FILTER (WHERE cost_type <> 'free' AND cost_record_count=0
               AND (recognized_revenue_cny>0 OR user_charge_cny>0)) AS unbooked_account_count,
             COUNT(*) FILTER (WHERE cost_type='free' AND cost_record_count>0) AS cost_conflict_count,
             COALESCE(SUM(recognized_revenue_cny) FILTER (WHERE cost_type <> 'free' AND cost_record_count=0),0) AS unbooked_revenue_cny,
             COALESCE(SUM(user_charge_cny) FILTER (WHERE cost_type <> 'free' AND cost_record_count=0),0) AS unbooked_user_charge_cny
      FROM account_costs`, [start, end]);
    const missing = await this.pool.query(`SELECT COUNT(*) AS count
      FROM ${this.schema}.dim_accounts WHERE cost_profile_id IS NULL AND status='active'`);

    const u = usage.rows[0];
    const c = cash.rows[0];
    const userChargeCny = number(u.user_charge_cny);
    const recognizedRevenueCny = number(u.recognized_revenue_cny);
    const pendingRevenueCny = number(u.pending_revenue_cny);
    const pendingUsageCount = number(u.pending_usage_count);
    const tokenListValueUsd = number(u.token_list_value_usd);
    const cost = costs.rows[0];
    const purchaseAllocatedCostCny = number(cost.purchase_allocated_cost_cny);
    const effectiveCost = number(cost.effective_cost_cny);
    const grossProfitCny = recognizedRevenueCny - effectiveCost;
    const received = number(c.received);
    const subscriptionReceived = number(c.subscription_received);
    const refunds = number(c.refunds);
    const gatewayFees = number(c.gateway_fees);
    const procurementSpend = number(c.procurement_spend);
    const missingCount = number(missing.rows[0].count);
    const unbookedAccountCount = number(cost.unbooked_account_count);
    const unbookedRevenueCny = number(cost.unbooked_revenue_cny);
    const unbookedUserChargeCny = number(cost.unbooked_user_charge_cny);
    const costConflictCount = number(cost.cost_conflict_count);
    const alerts = [];
    if (pendingUsageCount) alerts.push({
      severity: 'high',
      title: `${pendingUsageCount} 笔扣费尚未匹配余额批次`,
      detail: `未分配扣费 ${pendingRevenueCny.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}，请检查充值、赠送或返利账本`,
    });
    if (missingCount) alerts.push({
      severity: 'high',
      title: `${missingCount} 个账号缺少成本规则`,
      detail: '请在账号成本中心补充采购信息',
    });
    if (unbookedAccountCount) alerts.push({
      severity: 'high',
      title: `${unbookedAccountCount} 个账号存在用量但缺少 CNY 成本档案`,
      detail: `影响确认收入 ${unbookedRevenueCny.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}、余额扣费 ${unbookedUserChargeCny.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}；当前利润为已入账成本口径`,
    });
    if (costConflictCount) alerts.push({
      severity: 'high',
      title: `${costConflictCount} 个免费账号同时登记了 CNY 成本`,
      detail: '成本类型与成本期间冲突；当前按免费规则暂不计入，请修正成本模板或删除错误期间',
    });

    return {
      cash: {
        received, rechargeReceived: received, subscriptionReceived, totalReceived: received + subscriptionReceived,
        refunds, gatewayFees, procurementSpend,
        netInflow: received + subscriptionReceived - refunds - gatewayFees - procurementSpend,
      },
      operations: {
        revenue: recognizedRevenueCny, revenueCny: recognizedRevenueCny, recognizedRevenueCny,
        allocatedCost: purchaseAllocatedCostCny, allocatedCostCny: purchaseAllocatedCostCny,
        purchaseAllocatedCostCny,
        effectiveCostCny: effectiveCost, fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost, bookedProfitCny: grossProfitCny,
        grossProfit: grossProfitCny, grossProfitCny, profitBasis: 'booked_cost_only',
        unbookedAccountCount, unbookedRevenueCny, unbookedUserChargeCny,
        costConflictCount,
        grossMargin: recognizedRevenueCny ? grossProfitCny / recognizedRevenueCny : null,
        userChargeCny, tokenListValueUsd, pendingRevenueCny, pendingUsageCount,
      },
      usage: {
        requests: number(u.requests),
        inputTokens: number(u.input_tokens),
        outputTokens: number(u.output_tokens),
        cacheTokens: number(u.cache_tokens),
        activeUsers: number(u.active_users),
        activeAccounts: number(u.active_accounts),
        averageLatencyMs: number(u.average_latency_ms),
      },
      alerts,
    };
  }

  async getTrend({ start, end }) {
    const result = await this.pool.query(`
      WITH days AS (
        SELECT generate_series($1::date,$2::date,INTERVAL '1 day')::date AS day
      ), usage AS (
        SELECT day,source_account_id,SUM(recognized_revenue_cny) AS revenue_cny,
               SUM(user_charge_cny) AS charge_cny
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY day,source_account_id
      ), costs AS (
        SELECT d.day,p.source_account_id,
               SUM((p.base_amount+p.fee_amount+p.tax_amount) *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,((d.day+1)::timestamp AT TIME ZONE $3))-
                   GREATEST(p.effective_from,(d.day::timestamp AT TIME ZONE $3)))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS purchase_allocated_cost_cny
        FROM days d
        JOIN ${this.schema}.account_cost_periods p ON p.status='active'
          AND p.effective_from < ((d.day+1)::timestamp AT TIME ZONE $3)
          AND p.effective_to > (d.day::timestamp AT TIME ZONE $3)
        GROUP BY d.day,p.source_account_id
      ), account_daily AS (
        SELECT COALESCE(u.day,c.day) AS day,
               COALESCE(u.source_account_id,c.source_account_id) AS source_account_id,
               COALESCE(u.revenue_cny,0) AS revenue_cny,
               COALESCE(u.charge_cny,0) AS charge_cny,
               COALESCE(c.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny
        FROM usage u FULL JOIN costs c USING(day,source_account_id)
      ), economics AS (
        SELECT ad.*,
               ${effectiveCostSql(
                 'cp.cost_type',
                 '0',
                 'ad.purchase_allocated_cost_cny',
               )} AS effective_cost_cny
        FROM account_daily ad
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=ad.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      )
      SELECT d.day::text AS day,COALESCE(SUM(e.revenue_cny),0) AS revenue_cny,
             COALESCE(SUM(e.charge_cny),0) AS charge_cny,
             COALESCE(SUM(e.purchase_allocated_cost_cny),0) AS purchase_allocated_cost_cny,
             COALESCE(SUM(e.effective_cost_cny),0) AS effective_cost_cny,
             COALESCE(SUM(e.revenue_cny),0)-COALESCE(SUM(e.effective_cost_cny),0) AS profit_cny
      FROM days d LEFT JOIN economics e USING(day)
      GROUP BY d.day ORDER BY d.day`, [start, end, this.config.timezone]);
    return result.rows.map((row) => ({
      day: row.day,
      revenue: number(row.revenue_cny),
      revenueCny: number(row.revenue_cny),
      recognizedRevenueCny: number(row.revenue_cny),
      userChargeCny: number(row.charge_cny),
      allocatedCost: number(row.purchase_allocated_cost_cny),
      allocatedCostCny: number(row.purchase_allocated_cost_cny),
      purchaseAllocatedCostCny: number(row.purchase_allocated_cost_cny),
      effectiveCostCny: number(row.effective_cost_cny),
      fullyLoadedCostCny: number(row.effective_cost_cny),
      bookedCostCny: number(row.effective_cost_cny),
      profit: number(row.profit_cny),
      profitCny: number(row.profit_cny),
      grossProfitCny: number(row.profit_cny),
      bookedProfitCny: number(row.profit_cny),
    }));
  }

  async getUsageBreakdown({ start, end }) {
    const result = await this.pool.query(`
      WITH usage_by_model_account AS (
        SELECT model,source_account_id,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(user_charge_cny) AS charge_cny,
               SUM(recognized_revenue_cny) AS revenue_cny,
               SUM(standard_cost_usd_reference) AS allocation_weight
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY model,source_account_id
      ), account_weight AS (
        SELECT source_account_id,SUM(allocation_weight) AS allocation_weight,SUM(tokens) AS token_weight,SUM(requests) AS request_weight
        FROM usage_by_model_account GROUP BY source_account_id
      ), account_cost AS (
        SELECT p.source_account_id,COALESCE(cp.cost_type,'unconfigured') AS cost_type,
               SUM((p.base_amount+p.fee_amount+p.tax_amount) *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$2)-GREATEST(p.effective_from,$1))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS purchase_allocated_cost_cny
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
        WHERE p.status='active' AND p.effective_from < $2 AND p.effective_to > $1
        GROUP BY p.source_account_id,cp.cost_type
      ), economics AS (
        SELECT u.*,
               COALESCE(ac.cost_type,'unconfigured') AS cost_type,
               (ac.source_account_id IS NOT NULL) AS has_cost_record,
               CASE WHEN aw.allocation_weight > 0
                 THEN COALESCE(ac.purchase_allocated_cost_cny,0)*u.allocation_weight/aw.allocation_weight
                 WHEN aw.token_weight > 0
                 THEN COALESCE(ac.purchase_allocated_cost_cny,0)*u.tokens/aw.token_weight
                 WHEN aw.request_weight > 0
                 THEN COALESCE(ac.purchase_allocated_cost_cny,0)*u.requests/aw.request_weight
                 ELSE 0 END AS purchase_allocated_cost_cny
        FROM usage_by_model_account u
        LEFT JOIN account_weight aw USING(source_account_id)
        LEFT JOIN account_cost ac USING(source_account_id)
      ), model_economics AS (
        SELECT model,
               SUM(requests)::float8 AS requests,SUM(tokens)::float8 AS tokens,
               SUM(token_list_value_usd) AS token_list_value_usd,
               SUM(charge_cny) AS charge_cny,SUM(revenue_cny) AS revenue_cny,
               SUM(purchase_allocated_cost_cny) AS purchase_allocated_cost_cny,
               SUM(${effectiveCostSql('cost_type','0','purchase_allocated_cost_cny')}) AS effective_cost_cny,
               COUNT(DISTINCT source_account_id) FILTER (WHERE cost_type <> 'free' AND NOT has_cost_record) AS unbooked_account_count
        FROM economics GROUP BY model
      )
      SELECT model AS name,requests,tokens,token_list_value_usd,charge_cny,revenue_cny,
             purchase_allocated_cost_cny,effective_cost_cny,unbooked_account_count,
             revenue_cny-effective_cost_cny AS profit_cny
      FROM model_economics ORDER BY revenue_cny DESC LIMIT 20`, [start, end]);
    return result.rows.map((row) => ({
      ...row,
      requests: number(row.requests),
      tokens: number(row.tokens),
      tokenListValueUsd: number(row.token_list_value_usd),
      userChargeCny: number(row.charge_cny),
      recognizedRevenueCny: number(row.revenue_cny),
      revenue: number(row.revenue_cny),
      revenueCny: number(row.revenue_cny),
      purchaseAllocatedCostCny: number(row.purchase_allocated_cost_cny),
      effectiveCostCny: number(row.effective_cost_cny),
      fullyLoadedCostCny: number(row.effective_cost_cny),
      bookedCostCny: number(row.effective_cost_cny),
      cost: number(row.effective_cost_cny),
      costCny: number(row.effective_cost_cny),
      profit: number(row.profit_cny),
      profitCny: number(row.profit_cny),
      grossProfitCny: number(row.profit_cny),
      bookedProfitCny: number(row.profit_cny),
      unbookedAccountCount: number(row.unbooked_account_count),
      costCoverageStatus: number(row.unbooked_account_count) ? 'partial' : 'complete',
      margin: number(row.revenue_cny) ? number(row.profit_cny) / number(row.revenue_cny) : null,
    }));
  }

  async listUsers({ start, end, search = '', page = 1, pageSize = 20, offset = 0 }) {
    const result = await this.pool.query(`
      WITH usage_by_user_account AS (
        SELECT source_user_id,source_account_id,
               SUM(recognized_revenue_cny) AS revenue_cny,
               SUM(user_charge_cny) AS charge_cny,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(standard_cost_usd_reference) AS weight,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY source_user_id,source_account_id
      ), account_weight AS (
        SELECT source_account_id,SUM(weight) AS weight,SUM(tokens) AS token_weight,SUM(requests) AS request_weight
        FROM usage_by_user_account GROUP BY source_account_id
      ), account_cost AS (
        SELECT p.source_account_id,
               COALESCE(cp.cost_type,'unconfigured') AS cost_type,
               SUM((p.base_amount+p.fee_amount+p.tax_amount) *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$2)-GREATEST(p.effective_from,$1))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS period_cost
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
        WHERE p.status='active' AND p.effective_from < $2 AND p.effective_to > $1
        GROUP BY p.source_account_id,cp.cost_type
      ), user_account_economics AS (
        SELECT u.source_user_id,u.source_account_id,u.revenue_cny,u.charge_cny,u.token_list_value_usd,
               u.requests,u.tokens,
               COALESCE(ac.cost_type,'unconfigured') AS cost_type,
               (ac.source_account_id IS NOT NULL) AS has_cost_record,
               CASE WHEN aw.weight > 0 THEN COALESCE(ac.period_cost,0)*u.weight/aw.weight
                 WHEN aw.token_weight > 0 THEN COALESCE(ac.period_cost,0)*u.tokens/aw.token_weight
                 WHEN aw.request_weight > 0 THEN COALESCE(ac.period_cost,0)*u.requests/aw.request_weight
                 ELSE 0 END AS purchase_allocated_cost_cny
        FROM usage_by_user_account u
        LEFT JOIN account_weight aw USING(source_account_id)
        LEFT JOIN account_cost ac USING(source_account_id)
      ), user_economics AS (
        SELECT source_user_id,
               SUM(revenue_cny) AS revenue_cny,
               SUM(charge_cny) AS charge_cny,
               SUM(token_list_value_usd) AS token_list_value_usd,
               SUM(purchase_allocated_cost_cny) AS purchase_allocated_cost_cny,
               SUM(${effectiveCostSql('cost_type','0','purchase_allocated_cost_cny')}) AS effective_cost_cny,
               COUNT(DISTINCT source_account_id) FILTER (WHERE cost_type <> 'free' AND NOT has_cost_record) AS unbooked_account_count,
               SUM(requests)::float8 AS requests,SUM(tokens)::float8 AS tokens
        FROM user_account_economics GROUP BY source_user_id
      ), cash AS (
        SELECT source_user_id,
               COALESCE(SUM(base_amount) FILTER (WHERE transaction_type='recharge' AND direction='in' AND status <> 'void'),0) AS cash_paid_cny,
               COALESCE(SUM(credited_amount) FILTER (WHERE transaction_type='recharge' AND direction='in' AND status <> 'void'),0) AS credited_cny
        FROM ${this.schema}.cash_transactions
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY source_user_id
      )
      SELECT u.source_user_id AS id,u.email,u.username,u.tags,u.current_balance AS balance_cny,
             COALESCE(us.revenue_cny,0) AS revenue_cny,COALESCE(us.charge_cny,0) AS charge_cny,
             COALESCE(us.token_list_value_usd,0) AS token_list_value_usd,
             COALESCE(us.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
             COALESCE(us.effective_cost_cny,0) AS effective_cost_cny,
             COALESCE(us.unbooked_account_count,0) AS unbooked_account_count,
             COALESCE(us.requests,0)::float8 AS requests,COALESCE(us.tokens,0)::float8 AS tokens,
             COALESCE(c.cash_paid_cny,0) AS cash_paid_cny,COALESCE(c.credited_cny,0) AS credited_cny,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.dim_users u
      LEFT JOIN user_economics us ON us.source_user_id=u.source_user_id
      LEFT JOIN cash c ON c.source_user_id=u.source_user_id
      WHERE ($3='' OR u.email ILIKE '%'||$3||'%' OR u.username ILIKE '%'||$3||'%')
      ORDER BY revenue_cny DESC LIMIT $4 OFFSET $5`, [start, end, search, pageSize, offset]);
    return pageResult(result.rows.map((row) => {
      const recognizedRevenueCny = number(row.revenue_cny);
      const purchaseAllocatedCostCny = number(row.purchase_allocated_cost_cny);
      const effectiveCost = number(row.effective_cost_cny);
      const grossProfit = recognizedRevenueCny - effectiveCost;
      return {
        ...row,
        revenue: recognizedRevenueCny,
        revenueCny: recognizedRevenueCny,
        recognizedRevenueCny,
        userChargeCny: number(row.charge_cny),
        tokenListValueUsd: number(row.token_list_value_usd),
        purchaseAllocatedCostCny,
        allocatedCost: purchaseAllocatedCostCny,
        effectiveCostCny: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        requests: number(row.requests),
        tokens: number(row.tokens),
        grossProfit,
        grossProfitCny: grossProfit,
        bookedProfitCny: grossProfit,
        unbookedAccountCount: number(row.unbooked_account_count),
        costCoverageStatus: number(row.unbooked_account_count) ? 'partial' : 'complete',
        grossMargin: recognizedRevenueCny ? grossProfit / recognizedRevenueCny : null,
        cashPaidCny: number(row.cash_paid_cny),
        creditedCny: number(row.credited_cny),
        balanceCny: number(row.balance_cny),
        balanceCurrency: 'CNY',
      };
    }), page, pageSize);
  }

  async listAccounts({ start, end, search = '', page = 1, pageSize = 20, offset = 0 }) {
    const result = await this.pool.query(`
      WITH usage AS (
        SELECT source_account_id,SUM(recognized_revenue_cny) AS revenue_cny,
               SUM(user_charge_cny) AS user_charge_cny,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY source_account_id
      ), costs AS (
        SELECT source_account_id,SUM((base_amount+fee_amount+tax_amount) *
          GREATEST(0,EXTRACT(EPOCH FROM LEAST(effective_to,$2)-GREATEST(effective_from,$1))) /
          NULLIF(EXTRACT(EPOCH FROM effective_to-effective_from),0))::float8 AS period_cost,
          COUNT(*) AS cost_record_count
        FROM ${this.schema}.account_cost_periods
        WHERE status='active' AND effective_from < $2 AND effective_to > $1
        GROUP BY source_account_id
      )
      SELECT a.source_account_id AS id,a.name,a.platform,a.supplier,a.purchase_batch,a.status,a.expires_at,a.tags,
             COALESCE(cp.cost_type,'unconfigured') AS cost_type,COALESCE(u.revenue_cny,0) AS revenue_cny,
             COALESCE(u.user_charge_cny,0) AS user_charge_cny,COALESCE(u.token_list_value_usd,0) AS token_list_value_usd,
             COALESCE(c.period_cost,0) AS period_cost_cny,COALESCE(c.cost_record_count,0) AS cost_record_count,
             COALESCE(u.requests,0)::float8 AS requests,COALESCE(u.tokens,0)::float8 AS tokens,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.dim_accounts a
      LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      LEFT JOIN usage u ON u.source_account_id=a.source_account_id
      LEFT JOIN costs c ON c.source_account_id=a.source_account_id
      WHERE ($3='' OR a.name ILIKE '%'||$3||'%' OR a.platform ILIKE '%'||$3||'%' OR a.supplier ILIKE '%'||$3||'%')
      ORDER BY revenue_cny DESC LIMIT $4 OFFSET $5`, [start, end, search, pageSize, offset]);
    return pageResult(result.rows.map((row) => {
      const revenue = number(row.revenue_cny);
      const purchaseAllocatedCostCny = number(row.period_cost_cny);
      const requests = number(row.requests);
      const effectiveCost = effectiveCostCny(row.cost_type, 0, purchaseAllocatedCostCny);
      const grossProfit = revenue - effectiveCost;
      const hasCostRecord = number(row.cost_record_count) > 0;
      const costCoverageStatus = row.cost_type === 'free' || hasCostRecord ? 'complete' : requests ? 'missing' : 'pending';
      return {
        ...row,
        costType: row.cost_type,
        revenue,
        revenueCny: revenue,
        recognizedRevenueCny: revenue,
        userChargeCny: number(row.user_charge_cny),
        tokenListValueUsd: number(row.token_list_value_usd),
        periodCost: purchaseAllocatedCostCny,
        periodCostCny: purchaseAllocatedCostCny,
        purchaseAllocatedCostCny,
        effectiveCostCny: effectiveCost,
        fullyLoadedCost: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        idleCost: requests ? 0 : purchaseAllocatedCostCny,
        grossProfit,
        grossProfitCny: grossProfit,
        bookedProfitCny: grossProfit,
        costCoverageStatus,
        hasCostRecord,
        costConfigurationConflict: row.cost_type === 'free' && hasCostRecord,
        grossMargin: revenue ? grossProfit / revenue : null,
        requests,
        tokens: number(row.tokens),
      };
    }), page, pageSize);
  }

  async getSupplierOverview({ start, end, search = '' }) {
    const [supplierResult, purchaseResult] = await Promise.all([
      this.pool.query(`
        WITH usage AS (
          SELECT source_account_id,SUM(recognized_revenue_cny) AS revenue_cny,
                 SUM(user_charge_cny) AS user_charge_cny,
                 SUM(standard_cost_usd_reference) AS token_list_value_usd,
                 SUM(requests)::float8 AS requests,
                 SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens
          FROM ${this.schema}.fact_usage_daily
          WHERE day >= $1::date AND day <= $2::date
          GROUP BY source_account_id
        ), costs AS (
          SELECT source_account_id,SUM((base_amount+fee_amount+tax_amount) *
            GREATEST(0,EXTRACT(EPOCH FROM LEAST(effective_to,$2)-GREATEST(effective_from,$1))) /
            NULLIF(EXTRACT(EPOCH FROM effective_to-effective_from),0))::float8 AS purchase_allocated_cost_cny,
            COUNT(*) AS cost_record_count
          FROM ${this.schema}.account_cost_periods
          WHERE status='active' AND effective_from < $2 AND effective_to > $1
          GROUP BY source_account_id
        ), account_economics AS (
          SELECT a.source_account_id,a.platform,a.status,a.expires_at,a.cost_profile_id,
                 COALESCE(NULLIF(a.supplier,''),'未标记供应商') AS supplier,
                 COALESCE(cp.cost_type,'unconfigured') AS cost_type,
                 COALESCE(u.requests,0) AS requests,COALESCE(u.tokens,0) AS tokens,
                 COALESCE(u.revenue_cny,0) AS revenue_cny,COALESCE(u.user_charge_cny,0) AS user_charge_cny,
                 COALESCE(u.token_list_value_usd,0) AS token_list_value_usd,
                 COALESCE(c.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
                 COALESCE(c.cost_record_count,0) AS cost_record_count,
                 ${effectiveCostSql(
                   'cp.cost_type',
                   '0',
                   'COALESCE(c.purchase_allocated_cost_cny,0)',
                 )} AS effective_cost_cny
          FROM ${this.schema}.dim_accounts a
          LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
          LEFT JOIN usage u ON u.source_account_id=a.source_account_id
          LEFT JOIN costs c ON c.source_account_id=a.source_account_id
          WHERE ($3='' OR a.name ILIKE '%'||$3||'%' OR a.platform ILIKE '%'||$3||'%'
            OR a.supplier ILIKE '%'||$3||'%' OR a.purchase_batch ILIKE '%'||$3||'%')
        )
        SELECT supplier,ARRAY_AGG(DISTINCT platform) FILTER (WHERE platform <> '') AS platforms,
               COUNT(*)::int AS account_count,
               COUNT(*) FILTER (WHERE status='active')::int AS active_accounts,
               COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < NOW()+INTERVAL '14 days')::int AS expiring_accounts,
               COUNT(*) FILTER (WHERE cost_type='unconfigured')::int AS missing_rule_count,
               COALESCE(SUM(requests),0)::float8 AS requests,COALESCE(SUM(tokens),0)::float8 AS tokens,
               COALESCE(SUM(revenue_cny),0) AS revenue_cny,COALESCE(SUM(user_charge_cny),0) AS user_charge_cny,
               COALESCE(SUM(token_list_value_usd),0) AS token_list_value_usd,
               COALESCE(SUM(purchase_allocated_cost_cny),0) AS purchase_allocated_cost_cny,
               COALESCE(SUM(effective_cost_cny),0) AS effective_cost_cny,
               COUNT(*) FILTER (WHERE requests>0 AND cost_type <> 'free' AND cost_record_count=0)::int AS unbooked_account_count,
               COUNT(*) FILTER (WHERE cost_type='free' AND cost_record_count>0)::int AS cost_conflict_count
        FROM account_economics GROUP BY supplier
        ORDER BY purchase_allocated_cost_cny DESC,revenue_cny DESC`, [start, end, search]),
      this.pool.query(`
        SELECT p.id,p.source_account_id AS account_id,a.name AS account_name,
               COALESCE(NULLIF(p.supplier,''),NULLIF(a.supplier,''),'未标记供应商') AS supplier,
               COALESCE(NULLIF(p.purchase_batch,''),NULLIF(a.purchase_batch,''),'未标记批次') AS purchase_batch,
               COALESCE(cp.name,cp.cost_type,'未绑定模板') AS cost_profile,
               p.original_amount::float8,p.original_currency,
               (p.base_amount+p.fee_amount+p.tax_amount)::float8 AS total_cost,
               p.effective_from,p.effective_to,p.status
        FROM ${this.schema}.account_cost_periods p
        JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=p.cost_profile_id
        WHERE p.effective_from < $2 AND p.effective_to > $1
          AND ($3='' OR a.name ILIKE '%'||$3||'%' OR a.platform ILIKE '%'||$3||'%'
            OR a.supplier ILIKE '%'||$3||'%' OR p.supplier ILIKE '%'||$3||'%'
            OR a.purchase_batch ILIKE '%'||$3||'%' OR p.purchase_batch ILIKE '%'||$3||'%')
        ORDER BY p.effective_from DESC LIMIT 100`, [start, end, search]),
    ]);

    const items = supplierResult.rows.map((row) => {
      const revenue = number(row.revenue_cny);
      const purchaseAllocatedCostCny = number(row.purchase_allocated_cost_cny);
      const effectiveCost = number(row.effective_cost_cny);
      const grossProfit = revenue - effectiveCost;
      return {
        supplier: row.supplier,
        platforms: row.platforms || [],
        accountCount: number(row.account_count),
        activeAccounts: number(row.active_accounts),
        expiringAccounts: number(row.expiring_accounts),
        missingRuleCount: number(row.missing_rule_count),
        requests: number(row.requests),
        tokens: number(row.tokens),
        revenue,
        revenueCny: revenue,
        recognizedRevenueCny: revenue,
        userChargeCny: number(row.user_charge_cny),
        tokenListValueUsd: number(row.token_list_value_usd),
        purchaseSpend: purchaseAllocatedCostCny,
        purchaseAllocatedCostCny,
        effectiveCostCny: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        grossProfit,
        grossProfitCny: grossProfit,
        bookedProfitCny: grossProfit,
        unbookedAccountCount: number(row.unbooked_account_count),
        costConflictCount: number(row.cost_conflict_count),
        costCoverageStatus: number(row.unbooked_account_count) ? 'partial' : 'complete',
        grossMargin: revenue ? grossProfit / revenue : null,
      };
    });
    const purchases = purchaseResult.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      supplier: row.supplier,
      purchaseBatch: row.purchase_batch,
      costProfile: row.cost_profile,
      originalAmount: number(row.total_cost),
      originalCurrency: 'CNY',
      totalCost: number(row.total_cost),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      status: row.status,
    }));
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

  async listCashTransactions({ start, end, page = 1, pageSize = 20, offset = 0, search = '' }) {
    const [result, totals] = await Promise.all([this.pool.query(`
      SELECT t.id,COALESCE(NULLIF(t.metadata->>'reference',''),t.source_id::text) AS reference,t.transaction_type AS type,t.direction,
             t.original_amount AS amount,t.original_currency AS currency,t.base_amount,t.credited_amount,t.credited_currency,
             t.order_type,t.source_status,t.payment_method AS method,t.status,t.occurred_at,
             COALESCE(NULLIF(t.metadata->>'party',''),u.email,'') AS party,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.cash_transactions t
      LEFT JOIN ${this.schema}.dim_users u ON u.source_user_id=t.source_user_id
      WHERE t.occurred_at >= $1 AND t.occurred_at < $2 AND t.status <> 'void'
        AND ($3='' OR t.source_id::text ILIKE '%'||$3||'%' OR t.transaction_type ILIKE '%'||$3||'%'
          OR t.payment_method ILIKE '%'||$3||'%' OR COALESCE(t.metadata->>'party','') ILIKE '%'||$3||'%'
          OR COALESCE(u.email,'') ILIKE '%'||$3||'%')
      ORDER BY t.occurred_at DESC LIMIT $4 OFFSET $5`, [start,end,search,pageSize,offset]), this.pool.query(`
       SELECT COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND status <> 'void'),0) AS inflow,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND status <> 'void'),0) AS outflow,
             COALESCE(SUM(base_amount) FILTER (WHERE transaction_type='refund' AND status <> 'void'),0) AS refunds,
             COUNT(*)::int AS transactions
      FROM ${this.schema}.cash_transactions WHERE occurred_at >= $1 AND occurred_at < $2 AND status <> 'void'`, [start,end])]);
    const paged = pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      id: row.id,
      reference: row.reference,
      type: row.type,
      direction: row.direction,
      orderType: row.order_type,
      sourceStatus: row.source_status,
      method: row.method,
      status: row.status,
      party: row.party,
      occurredAt: row.occurred_at,
      amount: number(row.base_amount),
      currency: 'CNY',
      baseAmountCny: number(row.base_amount),
      creditedAmount: number(row.credited_amount),
      creditedAmountCny: number(row.credited_amount),
      creditedCurrency: 'CNY',
    })), page, pageSize);
    const summary = totals.rows[0];
    return { ...paged, summary: {
      inflow: number(summary.inflow), outflow: number(summary.outflow), refunds: number(summary.refunds),
      net: number(summary.inflow) - number(summary.outflow), transactions: number(summary.transactions),
    } };
  }

  async getReconciliation({ start, end }) {
    const result = await this.pool.query(`
      SELECT reconciliation_type AS type,status,source_total,finops_total,difference,details,completed_at
      FROM ${this.schema}.reconciliation_runs
      WHERE period_start >= $1 AND period_end <= $2
      ORDER BY started_at DESC LIMIT 20`, [start,end]);
    const labels = {
      usage: '用量与扣费', credit_usage_cny: '钱包扣费对账', payment: '支付订单', cost: '账号采购成本',
    };
    return result.rows.map((row) => {
      const sourceType = String(row.type || '');
      const type = sourceType.includes('wallet') && sourceType.includes('credit') ? 'credit_usage_cny' : sourceType;
      return {
        type,
        label: labels[type] || type,
        status: row.status,
        sourceTotal: number(row.source_total),
        finopsTotal: number(row.finops_total),
        difference: number(row.difference),
        unit: 'CNY',
        currency: 'CNY',
        checkedAt: row.completed_at,
      };
    });
  }

  async listCostProfiles() {
    const result = await this.pool.query(`
      SELECT cp.id,cp.name,cp.cost_type,cp.currency,cp.allocation_method,cp.version,
             COUNT(a.source_account_id)::int AS account_count
      FROM ${this.schema}.cost_profiles cp
      LEFT JOIN ${this.schema}.dim_accounts a ON a.cost_profile_id=cp.id
      GROUP BY cp.id ORDER BY cp.updated_at DESC`);
    return result.rows.map((row) => ({
      costType: row.cost_type,
      id: row.id,
      name: row.name,
      allocationMethod: row.allocation_method,
      currency: 'CNY',
      version: number(row.version),
      accountCount: number(row.account_count),
    }));
  }

  async createCostProfile(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO ${this.schema}.cost_profiles(name,cost_type,currency,allocation_method,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.name,input.costType,input.currency,input.allocationMethod,input.notes||'',actor]);
      const created = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create','cost_profile',$2,$3::jsonb)`, [actor,String(created.id),JSON.stringify(created)]);
      return created;
    });
  }

  async createAccountCostPeriod(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const account = await client.query(`SELECT a.source_account_id,cp.cost_type
        FROM ${this.schema}.dim_accounts a
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
        WHERE a.source_account_id=$1 FOR UPDATE OF a`, [input.accountId]);
      if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
      let selectedCostType = account.rows[0].cost_type;
      if (input.costProfileId) {
        const profile = await client.query(`SELECT id,cost_type FROM ${this.schema}.cost_profiles WHERE id=$1`, [input.costProfileId]);
        if (!profile.rowCount) throw httpError('cost profile not found', 404);
        selectedCostType = profile.rows[0].cost_type;
      }
      if (selectedCostType === 'free') throw httpError('free accounts cannot have a CNY cost period', 409);
      const result = await client.query(`
        INSERT INTO ${this.schema}.account_cost_periods(source_account_id,cost_profile_id,supplier,purchase_batch,original_amount,original_currency,fx_rate,base_amount,fee_amount,tax_amount,effective_from,effective_to,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [input.accountId,input.costProfileId||null,input.supplier||'',input.purchaseBatch||'',input.originalAmount,input.originalCurrency,input.fxRate||1,input.baseAmount,input.feeAmount||0,input.taxAmount||0,input.effectiveFrom,input.effectiveTo,input.notes||'',actor]);
      const created = result.rows[0];
      await client.query(`UPDATE ${this.schema}.dim_accounts SET
        cost_profile_id=COALESCE($2,cost_profile_id),supplier=COALESCE(NULLIF($3,''),supplier),
        purchase_batch=COALESCE(NULLIF($4,''),purchase_batch),
        tags=CASE WHEN $5::jsonb IS NULL THEN tags ELSE $5::jsonb END,synced_at=NOW()
        WHERE source_account_id=$1`, [input.accountId,input.costProfileId||null,input.supplier||'',input.purchaseBatch||'',Array.isArray(input.tags)?JSON.stringify(input.tags):null]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create','account_cost_period',$2,$3::jsonb)`, [actor,String(created.id),JSON.stringify(created)]);
      return created;
    });
  }

  async createCashTransaction(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      if (input.accountId) {
        const account = await client.query(`SELECT source_account_id FROM ${this.schema}.dim_accounts WHERE source_account_id=$1`, [input.accountId]);
        if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
      }
      const metadata = JSON.stringify({ reference: input.reference || '', party: input.party || '', notes: input.notes || '' });
      const tableName = `${this.config.finopsSchema}.cash_transactions`;
      const result = await client.query(`
        WITH next_id AS (SELECT nextval(pg_get_serial_sequence($1,'id')) AS id)
        INSERT INTO ${this.schema}.cash_transactions(
          id,source_table,source_id,transaction_type,direction,original_amount,original_currency,
          fx_rate,base_amount,source_account_id,payment_method,status,occurred_at,metadata)
        SELECT id,'manual',id,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11::jsonb FROM next_id
        RETURNING *`, [tableName,input.transactionType,input.direction,input.originalAmount,input.originalCurrency,input.fxRate,input.baseAmount,input.accountId||0,input.paymentMethod,input.occurredAt,metadata]);
      const created = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create','cash_transaction',$2,$3::jsonb)`, [actor,String(created.id),JSON.stringify(created)]);
      return {
        ...created,
        reference: input.reference || `MAN-${created.source_id}`,
        type: created.transaction_type,
        amount: number(created.original_amount),
        currency: created.original_currency,
        method: created.payment_method,
        party: input.party || '',
        occurredAt: created.occurred_at,
      };
    });
  }

  async getSyncState() {
    const result = await this.pool.query(`
      SELECT source_name,cursor_time,last_success_at,last_error,rows_synced
      FROM ${this.schema}.sync_cursors
      WHERE source_name = ANY($1::text[]) ORDER BY source_name`, [REQUIRED_SYNC_SOURCES]);
    const rowsBySource = new Map(result.rows.map((row) => [row.source_name, row]));
    const requiredRows = REQUIRED_SYNC_SOURCES.map((sourceName) => rowsBySource.get(sourceName)).filter(Boolean);
    const missingSources = REQUIRED_SYNC_SOURCES.filter((sourceName) => !rowsBySource.has(sourceName));
    const pendingSources = requiredRows.filter((row) => !row.last_success_at).map((row) => row.source_name);
    const successes = requiredRows.map((row) => row.last_success_at).filter(Boolean).map((value) => new Date(value));
    const oldestSuccess = successes.length ? new Date(Math.min(...successes.map((value) => value.getTime()))) : null;
    const errors = requiredRows.filter((row) => row.last_error).map((row) => `${row.source_name}: ${row.last_error}`);
    const lag = oldestSuccess ? Math.max(0,(Date.now()-oldestSuccess.getTime())/1000) : null;
    return {
      status: errors.length ? 'error' : missingSources.length || pendingSources.length ? 'pending' : 'healthy',
      lagSeconds: lag,
      lastSuccessAt: oldestSuccess,
      lastError: errors.join('; ') || null,
      rowsSynced: requiredRows.reduce((sum,row) => sum + number(row.rows_synced),0),
      missingSources,
      pendingSources,
    };
  }

  async getSyncDetails() {
    const [cursorResult, dimensionResult, reconciliationResult] = await Promise.all([
      this.pool.query(`SELECT source_name,cursor_time,last_success_at,last_error,rows_synced
        FROM ${this.schema}.sync_cursors ORDER BY source_name`),
      this.pool.query(`SELECT MAX(synced_at) AS last_success_at,COUNT(*)::int AS rows_synced FROM (
        SELECT synced_at FROM ${this.schema}.dim_users
        UNION ALL SELECT synced_at FROM ${this.schema}.dim_accounts
      ) dimensions`),
      this.pool.query(`SELECT MAX(completed_at) AS last_success_at,COUNT(*)::int AS rows_synced
        FROM ${this.schema}.reconciliation_runs`),
    ]);
    const cursorBySource = new Map(cursorResult.rows.map((row) => [row.source_name, row]));
    const cursorSourceNames = [
      ...REQUIRED_SYNC_SOURCES,
      ...cursorResult.rows.map((row) => row.source_name).filter((sourceName) => !REQUIRED_SYNC_SOURCES.includes(sourceName)),
    ];
    const sources = cursorSourceNames.map((sourceName) => {
      const row = cursorBySource.get(sourceName);
      const lastSuccessAt = row?.last_success_at ? new Date(row.last_success_at) : null;
      return {
        sourceName,
        label: SYNC_SOURCE_LABELS[sourceName] || sourceName,
        status: row?.last_error ? 'error' : lastSuccessAt ? 'healthy' : 'pending',
        cursorTime: row?.cursor_time || null,
        lastSuccessAt,
        lagSeconds: lastSuccessAt ? Math.max(0, (Date.now() - lastSuccessAt.getTime()) / 1000) : null,
        rowsSynced: number(row?.rows_synced),
        lastError: row?.last_error || null,
      };
    });
    const appendSource = (sourceName, label, row) => {
      const lastSuccessAt = row?.last_success_at ? new Date(row.last_success_at) : null;
      sources.push({
        sourceName,
        label,
        status: lastSuccessAt ? 'healthy' : 'pending',
        cursorTime: null,
        lastSuccessAt,
        lagSeconds: lastSuccessAt ? Math.max(0, (Date.now() - lastSuccessAt.getTime()) / 1000) : null,
        rowsSynced: number(row?.rows_synced),
        lastError: null,
      });
    };
    appendSource('dimensions', '用户与账号', dimensionResult.rows[0]);
    appendSource('reconciliation', '自动对账', reconciliationResult.rows[0]);
    const successes = sources.filter((item) => item.lastSuccessAt).map((item) => item.lastSuccessAt.getTime());
    const errorCount = sources.filter((item) => item.status === 'error').length;
    const pendingCount = sources.filter((item) => item.status === 'pending').length;
    return {
      status: errorCount ? 'error' : pendingCount ? 'pending' : 'healthy',
      lagSeconds: successes.length ? Math.max(...sources.map((item) => item.lagSeconds || 0)) : null,
      lastSuccessAt: successes.length ? new Date(Math.min(...successes)) : null,
      rowsSynced: sources.reduce((sum, item) => sum + item.rowsSynced, 0),
      errorCount,
      sources,
    };
  }
}
