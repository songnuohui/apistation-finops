import { inTransaction } from '../db.mjs';
import Decimal from 'decimal.js/decimal.mjs';
import { splitFixedCostCny } from '../services/cost-accounting.mjs';

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function cnySum(...values) {
  return values.reduce((total, value) => total.plus(value || 0), new Decimal(0)).toString();
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

export function allocatedCostSql(
  allocationMethodExpression,
  costExpression,
  standardWeightExpression,
  totalStandardWeightExpression,
  tokenWeightExpression,
  totalTokenWeightExpression,
  requestWeightExpression,
  totalRequestWeightExpression,
) {
  return `CASE LOWER(COALESCE(${allocationMethodExpression}, 'standard_cost_weight'))
    WHEN 'none' THEN 0
    WHEN 'token_weight' THEN CASE
      WHEN ${totalTokenWeightExpression} > 0 THEN ${costExpression}*${tokenWeightExpression}/${totalTokenWeightExpression}
      WHEN ${totalRequestWeightExpression} > 0 THEN ${costExpression}*${requestWeightExpression}/${totalRequestWeightExpression}
      ELSE 0
    END
    ELSE CASE
      WHEN ${totalStandardWeightExpression} > 0 THEN ${costExpression}*${standardWeightExpression}/${totalStandardWeightExpression}
      WHEN ${totalTokenWeightExpression} > 0 THEN ${costExpression}*${tokenWeightExpression}/${totalTokenWeightExpression}
      WHEN ${totalRequestWeightExpression} > 0 THEN ${costExpression}*${requestWeightExpression}/${totalRequestWeightExpression}
      ELSE 0
    END
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

export const REQUIRED_SYNC_SOURCES = Object.freeze([
  'usage_logs', 'payment_orders', 'redeem_codes', 'user_affiliate_ledger',
  'payment_audit_logs', 'credit_reconciliation',
]);

function pageResult(rows, page, pageSize) {
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { items: rows.map(({ total_count, ...row }) => row), total, page, pageSize };
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function assertResolvedCostRule({ costMode, basisMode, upstreamMultiplier, sellingMultiplier, cnyPerReferenceUnit }) {
  if (costMode === 'manual_multiplier' && !upstreamMultiplier) {
    throw httpError('manual_multiplier requires an account or template upstreamMultiplier', 400);
  }
  if (basisMode === 'reference_cny' && !cnyPerReferenceUnit) {
    throw httpError('reference_cny requires an account or template cnyPerReferenceUnit', 400);
  }
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
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(input_tokens),0) AS input_tokens,
             COALESCE(SUM(output_tokens),0) AS output_tokens,
             COALESCE(SUM(cache_creation_tokens + cache_read_tokens),0) AS cache_tokens,
             COUNT(DISTINCT source_user_id) FILTER (WHERE source_user_id <> 0) AS active_users,
             COUNT(DISTINCT source_account_id) FILTER (WHERE source_account_id <> 0) AS active_accounts,
             COALESCE(AVG(duration_ms),0) AS average_latency_ms,
             COALESCE(SUM(user_charge_cny),0) AS user_charge_cny,
             COALESCE(SUM(standard_cost_usd_reference),0) AS token_list_value_usd
      FROM ${this.schema}.fact_usage_events
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const cash = await this.pool.query(`
      SELECT COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND transaction_type='recharge' AND status <> 'void'),0) AS received,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type='refund' AND status <> 'void'),0) AS refunds,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type='gateway_fee'),0) AS gateway_fees,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type IN ('account_purchase','supplier_topup','subscription_renewal')),0) AS procurement_spend
      FROM ${this.schema}.cash_transactions
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const costs = await this.pool.query(`
      WITH usage_by_account AS (
        SELECT source_account_id,COALESCE(SUM(user_charge_cny),0) AS user_charge_cny
        FROM ${this.schema}.fact_usage_events
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY source_account_id
      ), multiplier_by_account AS (
        SELECT source_account_id,
               COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(user_charge_cny) FILTER (
                 WHERE cost_status NOT IN ('priced','free','fixed_cost')
               ),0) AS unpriced_user_charge_cny,
               COUNT(*) FILTER (WHERE cost_status='priced') AS priced_usage_count,
               MAX(cost_mode) AS cost_mode
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY source_account_id
      ), fixed_by_account AS (
        SELECT p.source_account_id,
               COALESCE(SUM(p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$2)-GREATEST(p.effective_from,$1))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)),0) AS fixed_cost_cny,
               COUNT(*) AS fixed_cost_record_count
        FROM ${this.schema}.account_fixed_cost_periods p
        WHERE p.status='active' AND p.effective_from < $2 AND p.effective_to > $1
        GROUP BY p.source_account_id
      ), account_costs AS (
        SELECT COALESCE(u.source_account_id,m.source_account_id,f.source_account_id) AS source_account_id,
               COALESCE(u.user_charge_cny,0) AS user_charge_cny,
               COALESCE(m.multiplier_cost_cny,0) AS multiplier_cost_cny,
               COALESCE(f.fixed_cost_cny,0) AS fixed_cost_cny,
               COALESCE(f.fixed_cost_record_count,0) AS fixed_cost_record_count,
               COALESCE(m.priced_usage_count,0) AS priced_usage_count,
               COALESCE(m.unpriced_user_charge_cny,0) AS multiplier_unpriced_user_charge_cny,
               COALESCE(m.cost_mode,account_profile.cost_mode,
                 CASE
                   WHEN account_profile.cost_type='free' THEN 'free'
                   WHEN COALESCE(f.fixed_cost_record_count,0)>0 THEN 'fixed_purchase'
                   ELSE 'unconfigured'
                 END
               ) AS cost_mode
        FROM usage_by_account u
        FULL JOIN multiplier_by_account m USING(source_account_id)
        FULL JOIN fixed_by_account f USING(source_account_id)
        LEFT JOIN ${this.schema}.dim_accounts a
          ON a.source_account_id=COALESCE(u.source_account_id,m.source_account_id,f.source_account_id)
        LEFT JOIN ${this.schema}.cost_profiles account_profile ON account_profile.id=a.cost_profile_id
      )
      SELECT COALESCE(SUM(fixed_cost_cny),0) AS fixed_cost_cny,
             COALESCE(SUM(multiplier_cost_cny),0) AS multiplier_cost_cny,
             COALESCE(SUM(fixed_cost_cny+multiplier_cost_cny),0) AS effective_cost_cny,
             COUNT(*) FILTER (WHERE user_charge_cny>0 AND (
               multiplier_unpriced_user_charge_cny>0
               OR (cost_mode='fixed_purchase' AND fixed_cost_record_count=0)
               OR cost_mode='unconfigured'
             )) AS unbooked_account_count,
             COALESCE(SUM(CASE
               WHEN multiplier_unpriced_user_charge_cny>0 THEN multiplier_unpriced_user_charge_cny
               WHEN cost_mode IN ('fixed_purchase','unconfigured') AND fixed_cost_record_count=0 THEN user_charge_cny
               ELSE 0
             END),0) AS unbooked_user_charge_cny
      FROM account_costs`, [start, end]);
    const missing = await this.pool.query(`SELECT COUNT(*) AS count
      FROM ${this.schema}.dim_accounts WHERE cost_profile_id IS NULL AND status='active'`);

    const u = usage.rows[0];
    const c = cash.rows[0];
    const userChargeCny = number(u.user_charge_cny);
    const tokenListValueUsd = number(u.token_list_value_usd);
    const cost = costs.rows[0];
    const purchaseAllocatedCostCny = number(cost.fixed_cost_cny);
    const multiplierCostCny = number(cost.multiplier_cost_cny);
    const effectiveCost = number(cost.effective_cost_cny);
    const grossProfitCny = userChargeCny - effectiveCost;
    const received = number(c.received);
    const refunds = number(c.refunds);
    const gatewayFees = number(c.gateway_fees);
    const procurementSpend = number(c.procurement_spend);
    const missingCount = number(missing.rows[0].count);
    const unbookedAccountCount = number(cost.unbooked_account_count);
    const unbookedUserChargeCny = number(cost.unbooked_user_charge_cny);
    const costConflictCount = 0;
    const alerts = [];
    if (missingCount) alerts.push({
      severity: 'high',
      title: `${missingCount} 个账号缺少成本规则`,
      detail: '请在账号成本中心补充采购信息',
    });
    if (unbookedAccountCount) alerts.push({
      severity: 'high',
      title: `${unbookedAccountCount} 个账号存在用量但缺少 CNY 成本档案`,
      detail: `影响用户实际消费 ${unbookedUserChargeCny.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}；当前利润为已登记成本口径`,
    });
    if (costConflictCount) alerts.push({
      severity: 'high',
      title: `${costConflictCount} 个免费账号同时登记了 CNY 成本`,
      detail: '成本类型与成本期间冲突；当前按免费规则暂不计入，请修正成本模板或删除错误期间',
    });

    return {
      cash: {
        received, rechargeReceived: received, totalReceived: received,
        refunds, gatewayFees, procurementSpend,
        netInflow: received - refunds - gatewayFees - procurementSpend,
      },
      operations: {
        consumptionCny: userChargeCny,
        revenue: userChargeCny, revenueCny: userChargeCny, recognizedRevenueCny: userChargeCny,
        allocatedCost: purchaseAllocatedCostCny, allocatedCostCny: purchaseAllocatedCostCny,
        purchaseAllocatedCostCny, multiplierCostCny,
        effectiveCostCny: effectiveCost, fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost, bookedProfitCny: grossProfitCny,
        grossProfit: grossProfitCny, grossProfitCny, profitBasis: 'booked_cost_only',
        unbookedAccountCount, unbookedRevenueCny: unbookedUserChargeCny, unbookedUserChargeCny,
        costConflictCount,
        grossMargin: userChargeCny ? grossProfitCny / userChargeCny : null,
        userChargeCny, tokenListValueUsd,
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

  async getTrend({ start, end, dailyStart = start, dailyEnd = end, preset = '7d' }) {
    const [result, rechargeEvents] = await Promise.all([this.pool.query(`
      WITH days AS (
        SELECT generate_series($1::date,$2::date,INTERVAL '1 day')::date AS day
      ), usage AS (
        SELECT day,source_account_id,SUM(user_charge_cny) AS revenue_cny,
               SUM(user_charge_cny) AS charge_cny
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY day,source_account_id
      ), multiplier_costs AS (
        SELECT (occurred_at AT TIME ZONE $3)::date AS day,source_account_id,
               COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $4 AND occurred_at < $5
        GROUP BY (occurred_at AT TIME ZONE $3)::date,source_account_id
      ), costs AS (
        SELECT d.day,p.source_account_id,
               SUM(p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,((d.day+1)::timestamp AT TIME ZONE $3))-
                   GREATEST(p.effective_from,(d.day::timestamp AT TIME ZONE $3)))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS purchase_allocated_cost_cny
        FROM days d
        JOIN ${this.schema}.account_fixed_cost_periods p ON p.status='active'
          AND p.effective_from < ((d.day+1)::timestamp AT TIME ZONE $3)
          AND p.effective_to > (d.day::timestamp AT TIME ZONE $3)
        GROUP BY d.day,p.source_account_id
      ), account_daily AS (
        SELECT COALESCE(u.day,c.day,m.day) AS day,
               COALESCE(u.source_account_id,c.source_account_id,m.source_account_id) AS source_account_id,
               COALESCE(u.revenue_cny,0) AS revenue_cny,
               COALESCE(u.charge_cny,0) AS charge_cny,
               COALESCE(c.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
               COALESCE(m.multiplier_cost_cny,0) AS multiplier_cost_cny,
               COALESCE(c.purchase_allocated_cost_cny,0)+COALESCE(m.multiplier_cost_cny,0) AS effective_cost_cny
        FROM usage u
        FULL JOIN costs c USING(day,source_account_id)
        FULL JOIN multiplier_costs m USING(day,source_account_id)
      ), economics AS (
        SELECT ad.*
        FROM account_daily ad
      ), cash AS (
        SELECT (occurred_at AT TIME ZONE $3)::date AS day,
               SUM(base_amount) FILTER (
                 WHERE transaction_type='recharge' AND direction='in' AND status <> 'void'
               ) AS recharge_cny
        FROM ${this.schema}.cash_transactions
        WHERE occurred_at >= $4 AND occurred_at < $5
        GROUP BY (occurred_at AT TIME ZONE $3)::date
      )
      SELECT d.day::text AS day,COALESCE(SUM(e.revenue_cny),0) AS revenue_cny,
             COALESCE(SUM(e.charge_cny),0) AS charge_cny,
             COALESCE(SUM(e.purchase_allocated_cost_cny),0) AS purchase_allocated_cost_cny,
             COALESCE(SUM(e.multiplier_cost_cny),0) AS multiplier_cost_cny,
             COALESCE(SUM(e.effective_cost_cny),0) AS effective_cost_cny,
             COALESCE(SUM(e.revenue_cny),0)-COALESCE(SUM(e.effective_cost_cny),0) AS profit_cny,
             COALESCE(MAX(c.recharge_cny),0) AS recharge_cny
      FROM days d
      LEFT JOIN economics e USING(day)
      LEFT JOIN cash c USING(day)
      GROUP BY d.day ORDER BY d.day`, [dailyStart, dailyEnd, this.config.timezone, start, end]),
      preset === 'today'
        ? this.pool.query(`
          SELECT id,occurred_at,base_amount,credited_amount,payment_method,
                 COALESCE(NULLIF(metadata->>'reference',''),source_id::text) AS reference
          FROM ${this.schema}.cash_transactions
          WHERE transaction_type='recharge' AND direction='in'
            AND status <> 'void' AND occurred_at >= $1 AND occurred_at < $2
          ORDER BY occurred_at ASC,id ASC`, [start, end])
        : Promise.resolve({ rows: [] }),
    ]);
    return {
      items: result.rows.map((row) => ({
      day: row.day,
      revenue: number(row.revenue_cny),
      revenueCny: number(row.revenue_cny),
      recognizedRevenueCny: number(row.revenue_cny),
      userChargeCny: number(row.charge_cny),
      allocatedCost: number(row.purchase_allocated_cost_cny),
      allocatedCostCny: number(row.purchase_allocated_cost_cny),
      purchaseAllocatedCostCny: number(row.purchase_allocated_cost_cny),
      multiplierCostCny: number(row.multiplier_cost_cny),
      effectiveCostCny: number(row.effective_cost_cny),
      fullyLoadedCostCny: number(row.effective_cost_cny),
      bookedCostCny: number(row.effective_cost_cny),
      profit: number(row.profit_cny),
      profitCny: number(row.profit_cny),
      grossProfitCny: number(row.profit_cny),
      bookedProfitCny: number(row.profit_cny),
      rechargeCny: number(row.recharge_cny),
      })),
      rechargeEvents: rechargeEvents.rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        amountCny: number(row.base_amount),
        creditedCny: number(row.credited_amount),
        paymentMethod: row.payment_method,
        reference: row.reference,
      })),
    };
  }

  async getUsageBreakdown({ start, end, dailyStart = start, dailyEnd = end, page = 1, pageSize = 20, offset = 0 }) {
    const result = await this.pool.query(`
      WITH usage_by_model_account AS (
        SELECT model,source_account_id,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(user_charge_cny) AS charge_cny,
               SUM(user_charge_cny) AS revenue_cny,
               SUM(standard_cost_usd_reference) AS allocation_weight
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY model,source_account_id
      ), account_weight AS (
        SELECT source_account_id,SUM(allocation_weight) AS allocation_weight,SUM(tokens) AS token_weight,SUM(requests) AS request_weight
        FROM usage_by_model_account GROUP BY source_account_id
      ), multiplier_cost AS (
        SELECT model,source_account_id,
               COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(user_charge_cny) FILTER (
                 WHERE cost_status NOT IN ('priced','free','fixed_cost')
               ),0) AS unpriced_user_charge_cny,
               MAX(cost_mode) AS cost_mode
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY model,source_account_id
      ), account_cost AS (
        SELECT p.source_account_id,
               SUM(p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS purchase_allocated_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.cost_type,'unconfigured'))='free' THEN 0 ELSE
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               END) AS effective_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS standard_cost_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS token_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS effective_standard_cost_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS effective_token_weight_cost_cny
        FROM ${this.schema}.account_fixed_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles period_profile ON period_profile.id=p.cost_profile_id
        WHERE p.status='active' AND p.effective_from < $4 AND p.effective_to > $3
        GROUP BY p.source_account_id
      ), economics AS (
        SELECT u.*,
               COALESCE(mc.cost_mode,current_profile.cost_mode,
                 CASE WHEN current_profile.cost_type='free' THEN 'free' ELSE 'unconfigured' END
               ) AS cost_type,
               (ac.source_account_id IS NOT NULL) AS has_cost_record,
               COALESCE(mc.multiplier_cost_cny,0) AS multiplier_cost_cny,
               COALESCE(mc.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny,
               ${allocatedCostSql("'standard_cost_weight'",'COALESCE(ac.standard_cost_weight_cost_cny,0)','u.allocation_weight','aw.allocation_weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + ${allocatedCostSql("'token_weight'",'COALESCE(ac.token_weight_cost_cny,0)','u.allocation_weight','aw.allocation_weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  AS purchase_allocated_cost_cny,
               ${allocatedCostSql("'standard_cost_weight'",'COALESCE(ac.effective_standard_cost_weight_cost_cny,0)','u.allocation_weight','aw.allocation_weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + ${allocatedCostSql("'token_weight'",'COALESCE(ac.effective_token_weight_cost_cny,0)','u.allocation_weight','aw.allocation_weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + COALESCE(mc.multiplier_cost_cny,0) AS effective_cost_cny
        FROM usage_by_model_account u
        LEFT JOIN account_weight aw USING(source_account_id)
        LEFT JOIN account_cost ac USING(source_account_id)
        LEFT JOIN multiplier_cost mc USING(model,source_account_id)
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=u.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles current_profile ON current_profile.id=a.cost_profile_id
      ), model_economics AS (
        SELECT model,
               SUM(requests)::float8 AS requests,SUM(tokens)::float8 AS tokens,
               SUM(token_list_value_usd) AS token_list_value_usd,
               SUM(charge_cny) AS charge_cny,SUM(revenue_cny) AS revenue_cny,
               SUM(purchase_allocated_cost_cny) AS purchase_allocated_cost_cny,
               SUM(multiplier_cost_cny) AS multiplier_cost_cny,
               SUM(effective_cost_cny) AS effective_cost_cny,
               COUNT(DISTINCT source_account_id) FILTER (WHERE
                 unpriced_user_charge_cny>0
                 OR (cost_type='fixed_purchase' AND NOT has_cost_record)
                 OR cost_type='unconfigured'
               ) AS unbooked_account_count
        FROM economics GROUP BY model
      )
      SELECT model AS name,requests,tokens,token_list_value_usd,charge_cny,revenue_cny,
             purchase_allocated_cost_cny,multiplier_cost_cny,effective_cost_cny,unbooked_account_count,
             revenue_cny-effective_cost_cny AS profit_cny,COUNT(*) OVER() AS total_count
      FROM model_economics ORDER BY revenue_cny DESC LIMIT $5 OFFSET $6`, [dailyStart, dailyEnd, start, end, pageSize, offset]);
    return pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      requests: number(row.requests),
      tokens: number(row.tokens),
      tokenListValueUsd: number(row.token_list_value_usd),
      userChargeCny: number(row.charge_cny),
      recognizedRevenueCny: number(row.revenue_cny),
      revenue: number(row.revenue_cny),
      revenueCny: number(row.revenue_cny),
      purchaseAllocatedCostCny: number(row.purchase_allocated_cost_cny),
      multiplierCostCny: number(row.multiplier_cost_cny),
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
    })), page, pageSize);
  }

  async listUsers({ start, end, dailyStart = start, dailyEnd = end, search = '', page = 1, pageSize = 20, offset = 0, sort = 'userChargeCny', direction = 'desc' }) {
    const sortColumns = {
      cashPaidCny: 'cash_paid_cny',
      adminCreditCny: 'admin_credit_cny',
      adminDeductionCny: 'admin_deduction_cny',
      balanceCny: 'balance_cny',
      userChargeCny: 'charge_cny',
      requests: 'requests',
      tokens: 'tokens',
      bookedCostCny: 'effective_cost_cny',
      bookedProfitCny: 'profit_cny',
    };
    const orderColumn = sortColumns[sort] || sortColumns.userChargeCny;
    const orderDirection = direction === 'asc' ? 'ASC' : 'DESC';
    const result = await this.pool.query(`
      WITH usage_by_user_account AS (
        SELECT source_user_id,source_account_id,
               SUM(user_charge_cny) AS revenue_cny,
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
      ), multiplier_cost AS (
        SELECT source_user_id,source_account_id,
               COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(user_charge_cny) FILTER (
                 WHERE cost_status NOT IN ('priced','free','fixed_cost')
               ),0) AS unpriced_user_charge_cny,
               MAX(cost_mode) AS cost_mode
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY source_user_id,source_account_id
      ), account_cost AS (
        SELECT p.source_account_id,
               SUM(p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)) AS period_cost,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.cost_type,'unconfigured'))='free' THEN 0 ELSE
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               END) AS effective_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS standard_cost_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS token_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS effective_standard_cost_weight_cost_cny,
               SUM(CASE WHEN LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 p.total_cost_cny *
                 GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
                 NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0)
               ELSE 0 END) AS effective_token_weight_cost_cny
        FROM ${this.schema}.account_fixed_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles period_profile ON period_profile.id=p.cost_profile_id
        WHERE p.status='active' AND p.effective_from < $4 AND p.effective_to > $3
        GROUP BY p.source_account_id
      ), user_account_economics AS (
        SELECT u.source_user_id,u.source_account_id,u.revenue_cny,u.charge_cny,u.token_list_value_usd,
               u.requests,u.tokens,
               COALESCE(mc.cost_mode,current_profile.cost_mode,
                 CASE WHEN current_profile.cost_type='free' THEN 'free' ELSE 'unconfigured' END
               ) AS cost_type,
               (ac.source_account_id IS NOT NULL) AS has_cost_record,
               COALESCE(mc.multiplier_cost_cny,0) AS multiplier_cost_cny,
               COALESCE(mc.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny,
               ${allocatedCostSql("'standard_cost_weight'",'COALESCE(ac.standard_cost_weight_cost_cny,0)','u.weight','aw.weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + ${allocatedCostSql("'token_weight'",'COALESCE(ac.token_weight_cost_cny,0)','u.weight','aw.weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  AS purchase_allocated_cost_cny,
               ${allocatedCostSql("'standard_cost_weight'",'COALESCE(ac.effective_standard_cost_weight_cost_cny,0)','u.weight','aw.weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + ${allocatedCostSql("'token_weight'",'COALESCE(ac.effective_token_weight_cost_cny,0)','u.weight','aw.weight','u.tokens','aw.token_weight','u.requests','aw.request_weight')}
                  + COALESCE(mc.multiplier_cost_cny,0) AS effective_cost_cny
        FROM usage_by_user_account u
        LEFT JOIN account_weight aw USING(source_account_id)
        LEFT JOIN account_cost ac USING(source_account_id)
        LEFT JOIN multiplier_cost mc USING(source_user_id,source_account_id)
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=u.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles current_profile ON current_profile.id=a.cost_profile_id
      ), user_economics AS (
        SELECT source_user_id,
               SUM(revenue_cny) AS revenue_cny,
               SUM(charge_cny) AS charge_cny,
               SUM(token_list_value_usd) AS token_list_value_usd,
               SUM(purchase_allocated_cost_cny) AS purchase_allocated_cost_cny,
               SUM(multiplier_cost_cny) AS multiplier_cost_cny,
               SUM(effective_cost_cny) AS effective_cost_cny,
               COUNT(DISTINCT source_account_id) FILTER (WHERE
                 unpriced_user_charge_cny>0
                 OR (cost_type='fixed_purchase' AND NOT has_cost_record)
                 OR cost_type='unconfigured'
               ) AS unbooked_account_count,
               SUM(requests)::float8 AS requests,SUM(tokens)::float8 AS tokens
        FROM user_account_economics GROUP BY source_user_id
      ), cash AS (
        SELECT source_user_id,
               COALESCE(SUM(base_amount) FILTER (WHERE transaction_type='recharge' AND direction='in' AND status <> 'void'),0) AS cash_paid_cny,
               COALESCE(SUM(credited_amount) FILTER (WHERE transaction_type='recharge' AND direction='in' AND status <> 'void'),0) AS credited_cny
        FROM ${this.schema}.cash_transactions
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY source_user_id
      ), adjustments AS (
        SELECT source_user_id,
               COALESCE(SUM(credit_amount) FILTER (WHERE event_type='admin_adjustment' AND direction='in'),0) AS admin_credit_cny,
               COALESCE(SUM(credit_amount) FILTER (WHERE event_type='admin_adjustment' AND direction='out'),0) AS admin_deduction_cny,
               COALESCE(SUM(credit_amount) FILTER (WHERE event_type='redeem' AND direction='in'),0) AS redeemed_credit_cny,
               COALESCE(SUM(credit_amount) FILTER (WHERE event_type='affiliate_rebate' AND direction='in'),0) AS affiliate_credit_cny
        FROM ${this.schema}.credit_events
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY source_user_id
      )
      SELECT u.source_user_id AS id,u.email,u.username,u.tags,u.current_balance AS balance_cny,
             COALESCE(us.revenue_cny,0) AS revenue_cny,COALESCE(us.charge_cny,0) AS charge_cny,
             COALESCE(us.token_list_value_usd,0) AS token_list_value_usd,
             COALESCE(us.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
             COALESCE(us.multiplier_cost_cny,0) AS multiplier_cost_cny,
             COALESCE(us.effective_cost_cny,0) AS effective_cost_cny,
             COALESCE(us.unbooked_account_count,0) AS unbooked_account_count,
             COALESCE(us.requests,0)::float8 AS requests,COALESCE(us.tokens,0)::float8 AS tokens,
             COALESCE(c.cash_paid_cny,0) AS cash_paid_cny,COALESCE(c.credited_cny,0) AS credited_cny,
             COALESCE(ad.admin_credit_cny,0) AS admin_credit_cny,COALESCE(ad.admin_deduction_cny,0) AS admin_deduction_cny,
             COALESCE(ad.redeemed_credit_cny,0) AS redeemed_credit_cny,COALESCE(ad.affiliate_credit_cny,0) AS affiliate_credit_cny,
             COALESCE(us.revenue_cny,0)-COALESCE(us.effective_cost_cny,0) AS profit_cny,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.dim_users u
      LEFT JOIN user_economics us ON us.source_user_id=u.source_user_id
      LEFT JOIN cash c ON c.source_user_id=u.source_user_id
      LEFT JOIN adjustments ad ON ad.source_user_id=u.source_user_id
        WHERE ($5='' OR u.email ILIKE '%'||$5||'%' OR u.username ILIKE '%'||$5||'%')
      ORDER BY ${orderColumn} ${orderDirection} NULLS LAST,u.source_user_id ASC LIMIT $6 OFFSET $7`, [dailyStart, dailyEnd, start, end, search, pageSize, offset]);
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
        multiplierCostCny: number(row.multiplier_cost_cny),
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
        adminCreditCny: number(row.admin_credit_cny),
        adminDeductionCny: number(row.admin_deduction_cny),
        redeemedCreditCny: number(row.redeemed_credit_cny),
        affiliateCreditCny: number(row.affiliate_credit_cny),
        balanceCny: number(row.balance_cny),
        balanceCurrency: 'CNY',
      };
    }), page, pageSize);
  }

  async getUserDetails({ userId, start, end, dailyStart = start, dailyEnd = end, recharge, usage }) {
    const [profileResult, trendResult, rechargeResult, usageResult] = await Promise.all([
      this.pool.query(`
        WITH totals AS (
          SELECT
            COALESCE(SUM(user_charge_cny),0) AS consumption_cny,
            COUNT(*)::int AS requests,
            COALESCE(SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens),0) AS tokens
          FROM ${this.schema}.fact_usage_events
          WHERE source_user_id=$1 AND occurred_at >= $2 AND occurred_at < $3
        ), cash AS (
          SELECT COALESCE(SUM(base_amount),0) AS recharge_cny,
                 COALESCE(SUM(credited_amount),0) AS credited_cny
          FROM ${this.schema}.cash_transactions
          WHERE source_user_id=$1 AND transaction_type='recharge' AND direction='in'
            AND status <> 'void' AND occurred_at >= $2 AND occurred_at < $3
        ), adjustments AS (
          SELECT COALESCE(SUM(credit_amount) FILTER (WHERE event_type='admin_adjustment' AND direction='in'),0) AS admin_credit_cny,
                 COALESCE(SUM(credit_amount) FILTER (WHERE event_type='admin_adjustment' AND direction='out'),0) AS admin_deduction_cny
          FROM ${this.schema}.credit_events
          WHERE source_user_id=$1 AND occurred_at >= $2 AND occurred_at < $3
        )
        SELECT u.source_user_id AS id,u.email,u.username,u.tags,u.status,u.current_balance AS balance_cny,
               t.consumption_cny,t.requests,t.tokens,c.recharge_cny,c.credited_cny,
               a.admin_credit_cny,a.admin_deduction_cny
        FROM ${this.schema}.dim_users u
        CROSS JOIN totals t CROSS JOIN cash c CROSS JOIN adjustments a
        WHERE u.source_user_id=$1`, [userId, start, end]),
      this.pool.query(`
        WITH days AS (
          SELECT generate_series($2::date,$3::date,INTERVAL '1 day')::date AS day
        ), usage_by_day AS (
          SELECT (occurred_at AT TIME ZONE $4)::date AS day,
                 SUM(user_charge_cny) AS consumption_cny
          FROM ${this.schema}.fact_usage_events
          WHERE source_user_id=$1 AND occurred_at >= $5 AND occurred_at < $6
          GROUP BY (occurred_at AT TIME ZONE $4)::date
        ), recharge_by_day AS (
          SELECT (occurred_at AT TIME ZONE $4)::date AS day,
                 SUM(base_amount) AS recharge_cny
          FROM ${this.schema}.cash_transactions
          WHERE source_user_id=$1 AND transaction_type='recharge' AND direction='in'
            AND status <> 'void' AND occurred_at >= $5 AND occurred_at < $6
          GROUP BY (occurred_at AT TIME ZONE $4)::date
        )
        SELECT d.day::text AS day,COALESCE(u.consumption_cny,0) AS consumption_cny,
               COALESCE(c.recharge_cny,0) AS recharge_cny
        FROM days d
        LEFT JOIN usage_by_day u USING(day)
        LEFT JOIN recharge_by_day c USING(day)
        ORDER BY d.day`, [userId, dailyStart, dailyEnd, this.config.timezone, start, end]),
      this.pool.query(`
        SELECT id,occurred_at,base_amount,credited_amount,payment_method,status,
               COALESCE(NULLIF(metadata->>'reference',''),source_id::text) AS reference,
               COUNT(*) OVER() AS total_count
        FROM ${this.schema}.cash_transactions
        WHERE source_user_id=$1 AND transaction_type='recharge' AND direction='in'
          AND status <> 'void' AND occurred_at >= $2 AND occurred_at < $3
        ORDER BY occurred_at DESC,id DESC LIMIT $4 OFFSET $5`, [userId, start, end, recharge.pageSize, recharge.offset]),
      this.pool.query(`
        SELECT source_usage_id,occurred_at,model,requested_model,upstream_model,source_account_id,
               user_charge_cny,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
               duration_ms,COUNT(*) OVER() AS total_count
        FROM ${this.schema}.fact_usage_events
        WHERE source_user_id=$1 AND occurred_at >= $2 AND occurred_at < $3
        ORDER BY occurred_at DESC,source_usage_id DESC LIMIT $4 OFFSET $5`, [userId, start, end, usage.pageSize, usage.offset]),
    ]);
    if (!profileResult.rowCount) throw httpError('user not found; run synchronization first', 404);
    const profile = profileResult.rows[0];
    return {
      user: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        tags: profile.tags || [],
        status: profile.status,
        balanceCny: number(profile.balance_cny),
        consumptionCny: number(profile.consumption_cny),
        requests: number(profile.requests),
        tokens: number(profile.tokens),
        rechargeCny: number(profile.recharge_cny),
        creditedCny: number(profile.credited_cny),
        adminCreditCny: number(profile.admin_credit_cny),
        adminDeductionCny: number(profile.admin_deduction_cny),
      },
      trend: trendResult.rows.map((row) => ({
        day: row.day,
        consumptionCny: number(row.consumption_cny),
        rechargeCny: number(row.recharge_cny),
      })),
      recharges: pageResult(rechargeResult.rows.map((row) => ({
        total_count: row.total_count,
        id: row.id,
        occurredAt: row.occurred_at,
        amountCny: number(row.base_amount),
        creditedCny: number(row.credited_amount),
        paymentMethod: row.payment_method,
        reference: row.reference,
        status: row.status,
      })), recharge.page, recharge.pageSize),
      usage: pageResult(usageResult.rows.map((row) => ({
        total_count: row.total_count,
        sourceUsageId: row.source_usage_id,
        occurredAt: row.occurred_at,
        model: row.model,
        requestedModel: row.requested_model,
        upstreamModel: row.upstream_model,
        accountId: row.source_account_id,
        userChargeCny: number(row.user_charge_cny),
        tokens: number(row.input_tokens) + number(row.output_tokens) + number(row.cache_creation_tokens) + number(row.cache_read_tokens),
        durationMs: number(row.duration_ms),
      })), usage.page, usage.pageSize),
    };
  }

  async listAccounts({
    start, end, dailyStart = start, dailyEnd = end, search = '', scope = 'current', page = 1, pageSize = 20, offset = 0,
  }) {
    const scopePredicate = {
      current: "a.source_deleted_at IS NULL AND a.status='active'",
      deleted: 'a.source_deleted_at IS NOT NULL',
      all: 'TRUE',
    }[scope] || "a.source_deleted_at IS NULL AND a.status='active'";
    const result = await this.pool.query(`
      WITH usage AS (
        SELECT source_account_id,SUM(user_charge_cny) AS revenue_cny,
               SUM(user_charge_cny) AS user_charge_cny,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY source_account_id
      ), costs AS (
        SELECT p.source_account_id,SUM(p.total_cost_cny *
          GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
          NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0))::float8 AS period_cost,
          COUNT(*) AS cost_record_count
        FROM ${this.schema}.account_fixed_cost_periods p
        WHERE p.status='active' AND p.effective_from < $4 AND p.effective_to > $3
        GROUP BY p.source_account_id
      ), multiplier_costs AS (
        SELECT source_account_id,
               COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(user_charge_cny) FILTER (
                 WHERE cost_status NOT IN ('priced','free','fixed_cost')
               ),0) AS unpriced_user_charge_cny,
               MAX(cost_mode) AS cost_mode,
               MAX(upstream_multiplier) AS upstream_multiplier,
               MAX(selling_multiplier) AS selling_multiplier,
               MAX(upstream_multiplier_source) AS upstream_multiplier_source
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY source_account_id
      )
      SELECT a.source_account_id AS id,a.name,a.platform,a.supplier,a.purchase_batch,a.status,a.expires_at,
             a.source_deleted_at,a.tags,a.cost_profile_id,
              COALESCE(m.cost_mode,rule.cost_mode,cp.cost_mode,
                CASE
                  WHEN cp.cost_type='free' THEN 'free'
                  WHEN COALESCE(c.cost_record_count,0)>0 THEN 'fixed_purchase'
                  ELSE 'unconfigured'
                END
              ) AS cost_type,COALESCE(u.revenue_cny,0) AS revenue_cny,
              COALESCE(u.user_charge_cny,0) AS user_charge_cny,COALESCE(u.token_list_value_usd,0) AS token_list_value_usd,
              COALESCE(c.period_cost,0) AS period_cost_cny,COALESCE(m.multiplier_cost_cny,0) AS multiplier_cost_cny,
              COALESCE(c.period_cost,0)+COALESCE(m.multiplier_cost_cny,0) AS effective_cost_cny,
              COALESCE(m.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny,
              COALESCE(m.upstream_multiplier,rule.upstream_multiplier,probe.effective_rate_multiplier) AS upstream_multiplier,
              COALESCE(m.selling_multiplier,rule.selling_multiplier) AS selling_multiplier,
              COALESCE(rule.basis_mode,'revenue_backsolve') AS basis_mode,
              rule.cny_per_reference_unit AS cny_per_reference_unit,
              COALESCE(m.upstream_multiplier_source,
                CASE WHEN probe.id IS NOT NULL THEN 'probe_snapshot' ELSE '' END
              ) AS upstream_multiplier_source,
              probe.status AS probe_status,probe.observed_at AS probe_observed_at,probe.fresh_until AS probe_fresh_until,
              COALESCE(c.cost_record_count,0) AS cost_record_count,
              period.id AS current_cost_period_id,period.cost_profile_id AS current_cost_profile_id,
              period.original_amount AS current_original_amount,period.fee_amount AS current_fee_amount,
              period.tax_amount AS current_tax_amount,period.effective_from AS current_effective_from,
              period.effective_to AS current_effective_to,period.notes AS current_cost_notes,
              COALESCE(u.requests,0)::float8 AS requests,COALESCE(u.tokens,0)::float8 AS tokens,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.dim_accounts a
      LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      LEFT JOIN usage u ON u.source_account_id=a.source_account_id
      LEFT JOIN costs c ON c.source_account_id=a.source_account_id
      LEFT JOIN multiplier_costs m ON m.source_account_id=a.source_account_id
        LEFT JOIN LATERAL (
        SELECT r.*
        FROM ${this.schema}.account_cost_rules r
        WHERE r.source_account_id=a.source_account_id AND r.status='active'
          AND (r.effective_to IS NULL OR r.effective_to > NOW())
        ORDER BY r.effective_from DESC,r.id DESC LIMIT 1
      ) rule ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.*
        FROM ${this.schema}.upstream_billing_snapshots s
        WHERE s.source_account_id=a.source_account_id
        ORDER BY COALESCE(s.observed_at,s.received_at,s.last_attempt_at) DESC,s.id DESC LIMIT 1
      ) probe ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.id,p.cost_profile_id,p.original_amount,p.fee_amount,p.tax_amount,p.effective_from,p.effective_to,p.notes
        FROM ${this.schema}.account_fixed_cost_periods p
        WHERE p.source_account_id=a.source_account_id AND p.status='active'
        ORDER BY p.effective_from DESC,p.id DESC LIMIT 1
      ) period ON TRUE
      WHERE ${scopePredicate}
        AND ($5='' OR a.name ILIKE '%'||$5||'%' OR a.platform ILIKE '%'||$5||'%' OR a.supplier ILIKE '%'||$5||'%')
      ORDER BY revenue_cny DESC LIMIT $6 OFFSET $7`, [dailyStart, dailyEnd, start, end, search, pageSize, offset]);
    return pageResult(result.rows.map((row) => {
      const revenue = number(row.revenue_cny);
      const purchaseAllocatedCostCny = number(row.period_cost_cny);
      const requests = number(row.requests);
      const effectiveCost = number(row.effective_cost_cny);
      const grossProfit = revenue - effectiveCost;
      const hasCostRecord = number(row.cost_record_count) > 0;
      const unpricedUserChargeCny = number(row.unpriced_user_charge_cny);
      const costCoverageStatus = row.cost_type === 'free'
        || (row.cost_type === 'fixed_purchase' && hasCostRecord)
        || (['probe_multiplier','manual_multiplier'].includes(row.cost_type) && !unpricedUserChargeCny)
        ? 'complete'
        : requests
          ? row.source_deleted_at ? 'historical_unpriced' : 'missing'
          : 'pending';
      return {
        ...row,
        costMode: row.cost_type,
        costType: row.cost_type,
        costProfileId: row.cost_profile_id ? number(row.cost_profile_id) : null,
        revenue,
        revenueCny: revenue,
        recognizedRevenueCny: revenue,
        userChargeCny: number(row.user_charge_cny),
        tokenListValueUsd: number(row.token_list_value_usd),
        periodCost: purchaseAllocatedCostCny,
        periodCostCny: purchaseAllocatedCostCny,
        purchaseAllocatedCostCny,
        multiplierCostCny: number(row.multiplier_cost_cny),
        effectiveCostCny: effectiveCost,
        fullyLoadedCost: effectiveCost,
        fullyLoadedCostCny: effectiveCost,
        bookedCostCny: effectiveCost,
        idleCost: requests ? 0 : purchaseAllocatedCostCny,
        grossProfit,
        grossProfitCny: grossProfit,
        bookedProfitCny: grossProfit,
        costCoverageStatus,
        unpricedUserChargeCny,
        hasCostRecord,
        costConfigurationConflict: false,
        grossMargin: revenue ? grossProfit / revenue : null,
        requests,
        tokens: number(row.tokens),
        currentCostPeriodId: row.current_cost_period_id ? number(row.current_cost_period_id) : null,
        currentCostProfileId: row.current_cost_profile_id ? number(row.current_cost_profile_id) : null,
        currentOriginalAmount: number(row.current_original_amount),
        currentFeeAmount: number(row.current_fee_amount),
        currentTaxAmount: number(row.current_tax_amount),
        currentEffectiveFrom: row.current_effective_from || null,
        currentEffectiveTo: row.current_effective_to || null,
        currentCostNotes: row.current_cost_notes || '',
        sourceDeletedAt: row.source_deleted_at || null,
        lifecycle: row.source_deleted_at ? 'deleted' : row.status === 'active' ? 'current' : 'inactive',
        upstreamMultiplier: number(row.upstream_multiplier) || null,
        sellingMultiplier: number(row.selling_multiplier) || null,
        basisMode: row.basis_mode || 'revenue_backsolve',
        cnyPerReferenceUnit: number(row.cny_per_reference_unit) || null,
        upstreamMultiplierSource: row.upstream_multiplier_source || '',
        probeStatus: row.probe_status || '',
        probeObservedAt: row.probe_observed_at || null,
        probeFreshUntil: row.probe_fresh_until || null,
      };
    }), page, pageSize);
  }

  async listAccountCostPeriods({ accountId, page = 1, pageSize = 10, offset = 0 }) {
    const result = await this.pool.query(`
      SELECT p.id,p.source_account_id,p.cost_profile_id,
             COALESCE(cp.name,cp.cost_type,'未绑定模板') AS cost_profile,
             COALESCE(NULLIF(p.supplier,''),NULLIF(a.supplier,''),'未标记供应商') AS supplier,
             COALESCE(NULLIF(p.purchase_batch,''),NULLIF(a.purchase_batch,''),'未标记批次') AS purchase_batch,
             p.original_amount,p.fee_amount,p.tax_amount,p.total_cost_cny,
             p.original_currency,p.effective_from,p.effective_to,p.status,p.notes,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.account_cost_periods p
      JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
      LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=p.cost_profile_id
      WHERE p.source_account_id=$1
      ORDER BY p.effective_from DESC,p.id DESC
      LIMIT $2 OFFSET $3`, [accountId, pageSize, offset]);
    return pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      id: Number(row.id),
      accountId: Number(row.source_account_id),
      costProfileId: row.cost_profile_id ? Number(row.cost_profile_id) : null,
      costProfile: row.cost_profile,
      supplier: row.supplier,
      purchaseBatch: row.purchase_batch,
      originalAmount: number(row.original_amount),
      feeAmount: number(row.fee_amount),
      taxAmount: number(row.tax_amount),
      totalCost: number(row.total_cost_cny),
      originalCurrency: 'CNY',
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      status: row.status,
      notes: row.notes || '',
    })), page, pageSize);
  }

  async getSupplierOverview({ start, end, dailyStart = start, dailyEnd = end, search = '' }) {
    const [supplierResult, purchaseResult] = await Promise.all([
      this.pool.query(`
        WITH usage AS (
          SELECT source_account_id,SUM(user_charge_cny) AS revenue_cny,
                 SUM(user_charge_cny) AS user_charge_cny,
                 SUM(standard_cost_usd_reference) AS token_list_value_usd,
                 SUM(requests)::float8 AS requests,
                 SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens
          FROM ${this.schema}.fact_usage_daily
          WHERE day >= $1::date AND day <= $2::date
          GROUP BY source_account_id
        ), costs AS (
          SELECT p.source_account_id,SUM(p.total_cost_cny *
            GREATEST(0,EXTRACT(EPOCH FROM LEAST(p.effective_to,$4)-GREATEST(p.effective_from,$3))) /
            NULLIF(EXTRACT(EPOCH FROM p.effective_to-p.effective_from),0))::float8 AS purchase_allocated_cost_cny,
            COUNT(*) AS cost_record_count
          FROM ${this.schema}.account_fixed_cost_periods p
          WHERE p.status='active' AND p.effective_from < $4 AND p.effective_to > $3
          GROUP BY p.source_account_id
        ), multiplier_costs AS (
          SELECT source_account_id,
                 COALESCE(SUM(calculated_cost_cny) FILTER (WHERE cost_status='priced'),0) AS multiplier_cost_cny,
                 COALESCE(SUM(user_charge_cny) FILTER (
                   WHERE cost_status NOT IN ('priced','free','fixed_cost')
                 ),0) AS unpriced_user_charge_cny,
                 MAX(cost_mode) AS cost_mode
          FROM ${this.schema}.usage_cost_facts
          WHERE occurred_at >= $3 AND occurred_at < $4
          GROUP BY source_account_id
        ), account_economics AS (
          SELECT a.source_account_id,a.platform,a.status,a.expires_at,a.cost_profile_id,
                 COALESCE(NULLIF(a.supplier,''),'未标记供应商') AS supplier,
                 COALESCE(m.cost_mode,rule.cost_mode,cp.cost_mode,
                   CASE
                     WHEN cp.cost_type='free' THEN 'free'
                     WHEN COALESCE(c.cost_record_count,0)>0 THEN 'fixed_purchase'
                     ELSE 'unconfigured'
                   END
                 ) AS cost_type,
                 COALESCE(u.requests,0) AS requests,COALESCE(u.tokens,0) AS tokens,
                 COALESCE(u.revenue_cny,0) AS revenue_cny,COALESCE(u.user_charge_cny,0) AS user_charge_cny,
                 COALESCE(u.token_list_value_usd,0) AS token_list_value_usd,
                 COALESCE(c.purchase_allocated_cost_cny,0) AS purchase_allocated_cost_cny,
                 COALESCE(m.multiplier_cost_cny,0) AS multiplier_cost_cny,
                 COALESCE(c.purchase_allocated_cost_cny,0)+COALESCE(m.multiplier_cost_cny,0) AS effective_cost_cny,
                 COALESCE(c.cost_record_count,0) AS cost_record_count,
                 COALESCE(m.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny
          FROM ${this.schema}.dim_accounts a
          LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
          LEFT JOIN usage u ON u.source_account_id=a.source_account_id
          LEFT JOIN costs c ON c.source_account_id=a.source_account_id
          LEFT JOIN multiplier_costs m ON m.source_account_id=a.source_account_id
          LEFT JOIN LATERAL (
            SELECT r.cost_mode
            FROM ${this.schema}.account_cost_rules r
            WHERE r.source_account_id=a.source_account_id AND r.status='active'
              AND (r.effective_to IS NULL OR r.effective_to > NOW())
            ORDER BY r.effective_from DESC,r.id DESC LIMIT 1
          ) rule ON TRUE
          WHERE ($5='' OR a.name ILIKE '%'||$5||'%' OR a.platform ILIKE '%'||$5||'%'
            OR a.supplier ILIKE '%'||$5||'%' OR a.purchase_batch ILIKE '%'||$5||'%')
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
               COALESCE(SUM(multiplier_cost_cny),0) AS multiplier_cost_cny,
               COALESCE(SUM(effective_cost_cny),0) AS effective_cost_cny,
               COUNT(*) FILTER (WHERE requests>0 AND (
                 unpriced_user_charge_cny>0
                 OR (cost_type='fixed_purchase' AND cost_record_count=0)
                 OR cost_type='unconfigured'
               ))::int AS unbooked_account_count,
               0::int AS cost_conflict_count
        FROM account_economics GROUP BY supplier
        ORDER BY purchase_allocated_cost_cny DESC,revenue_cny DESC`, [dailyStart, dailyEnd, start, end, search]),
      this.pool.query(`
        SELECT p.id,p.source_account_id AS account_id,a.name AS account_name,
               COALESCE(NULLIF(p.supplier,''),NULLIF(a.supplier,''),'未标记供应商') AS supplier,
               COALESCE(NULLIF(p.purchase_batch,''),NULLIF(a.purchase_batch,''),'未标记批次') AS purchase_batch,
               COALESCE(cp.name,cp.cost_type,'未绑定模板') AS cost_profile,
               p.original_amount::float8,p.original_currency,
               p.total_cost_cny::float8 AS total_cost,
               p.effective_from,p.effective_to,p.status
        FROM ${this.schema}.account_fixed_cost_periods p
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
        multiplierCostCny: number(row.multiplier_cost_cny),
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
      const label = type === 'wallet_balance_cny' ? '用户余额对账' : labels[type] || type;
      return {
        type,
        label,
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
      SELECT cp.id,cp.name,cp.cost_type,cp.cost_mode,cp.basis_mode,cp.variable_multiplier,
             cp.cny_per_reference_unit,cp.default_selling_multiplier,
             cp.currency,cp.allocation_method,cp.version,
             COUNT(a.source_account_id)::int AS account_count
      FROM ${this.schema}.cost_profiles cp
      LEFT JOIN ${this.schema}.dim_accounts a ON a.cost_profile_id=cp.id
      GROUP BY cp.id ORDER BY cp.updated_at DESC`);
    return result.rows.map((row) => ({
      costType: row.cost_type,
      costMode: row.cost_mode,
      basisMode: row.basis_mode,
      variableMultiplier: row.variable_multiplier === null ? null : number(row.variable_multiplier),
      cnyPerReferenceUnit: row.cny_per_reference_unit === null ? null : number(row.cny_per_reference_unit),
      defaultSellingMultiplier: row.default_selling_multiplier === null ? null : number(row.default_selling_multiplier),
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
        INSERT INTO ${this.schema}.cost_profiles(
          name,cost_type,cost_mode,basis_mode,variable_multiplier,cny_per_reference_unit,
          default_selling_multiplier,currency,allocation_method,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        input.name,input.costType,input.costMode,input.basisMode,input.variableMultiplier,
        input.cnyPerReferenceUnit,input.defaultSellingMultiplier,input.currency,input.allocationMethod,
        input.notes||'',actor,
      ]);
      const created = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create','cost_profile',$2,$3::jsonb)`, [actor,String(created.id),JSON.stringify(created)]);
      return created;
    });
  }

  async listMonitorGroups() {
    const result = await this.pool.query(`
      WITH recent AS (
        SELECT monitor_group_id,
               COUNT(*)::int AS observation_count,
               COUNT(*) FILTER (WHERE status IN ('healthy','degraded'))::int AS available_count
        FROM ${this.schema}.monitor_group_observations
        WHERE observed_at >= NOW() - INTERVAL '7 days'
        GROUP BY monitor_group_id
      ), latest AS (
        SELECT DISTINCT ON (monitor_group_id)
               monitor_group_id,status,available_account_count,total_account_count,
               group_multiplier,user_multiplier,effective_multiplier,average_latency_ms,observed_at
        FROM ${this.schema}.monitor_group_observations
        ORDER BY monitor_group_id,observed_at DESC,id DESC
      )
      SELECT g.id,g.name,g.source_group_id,g.model_label,g.display_order,g.enabled,
             l.status,l.available_account_count,l.total_account_count,
             l.group_multiplier,l.user_multiplier,l.effective_multiplier,l.average_latency_ms,l.observed_at,
             r.observation_count,r.available_count
      FROM ${this.schema}.monitor_groups g
      LEFT JOIN latest l ON l.monitor_group_id=g.id
      LEFT JOIN recent r ON r.monitor_group_id=g.id
      ORDER BY g.display_order,g.id`);
    return result.rows.map((row) => ({
      id: number(row.id),
      name: row.name,
      sourceGroupId: number(row.source_group_id),
      modelLabel: row.model_label || '',
      displayOrder: number(row.display_order),
      enabled: Boolean(row.enabled),
      status: row.status || 'unknown',
      availableAccountCount: number(row.available_account_count),
      totalAccountCount: number(row.total_account_count),
      groupMultiplier: nullableNumber(row.group_multiplier),
      userMultiplier: nullableNumber(row.user_multiplier),
      effectiveMultiplier: nullableNumber(row.effective_multiplier),
      averageLatencyMs: nullableNumber(row.average_latency_ms),
      lastObservedAt: row.observed_at || null,
      availabilityPercent: number(row.observation_count)
        ? Number((number(row.available_count) * 100 / number(row.observation_count)).toFixed(2))
        : null,
    }));
  }

  async listMonitorGroupCandidates() {
    const result = await this.pool.query(`
      WITH usage_candidates AS (
        SELECT source_group_id,
               COUNT(*)::int AS requests,
               MAX(occurred_at) AS last_used_at,
               (array_agg(model ORDER BY occurred_at DESC))[1] AS latest_model
        FROM ${this.schema}.fact_usage_events
        WHERE source_group_id > 0
        GROUP BY source_group_id
      )
      SELECT COALESCE(c.source_group_id,u.source_group_id) AS source_group_id,
             COALESCE(c.name,'') AS name,
             COALESCE(c.platform,'') AS platform,
             COALESCE(c.status,'') AS status,
             c.rate_multiplier,c.sort_order,
             COALESCE(c.default_model,'') AS default_model,
             c.synced_at AS catalog_synced_at,
             COALESCE(u.requests,0)::int AS requests,
             u.last_used_at,
             COALESCE(u.latest_model,'') AS latest_model
      FROM ${this.schema}.source_group_catalog c
      FULL OUTER JOIN usage_candidates u ON u.source_group_id=c.source_group_id
      ORDER BY CASE WHEN c.status='active' THEN 0 ELSE 1 END,
               c.sort_order ASC NULLS LAST,u.last_used_at DESC NULLS LAST,source_group_id`);
    return result.rows.map((row) => ({
      sourceGroupId: number(row.source_group_id),
      name: row.name || '',
      platform: row.platform || '',
      status: row.status || '',
      groupMultiplier: nullableNumber(row.rate_multiplier),
      sortOrder: number(row.sort_order),
      defaultModel: row.default_model || '',
      catalogSyncedAt: row.catalog_synced_at || null,
      requests: number(row.requests),
      lastUsedAt: row.last_used_at || null,
      latestModel: row.latest_model || '',
    }));
  }

  async upsertSourceGroupCatalog(groups) {
    const catalog = groups.filter((group) => Number.isSafeInteger(Number(group.sourceGroupId)) && Number(group.sourceGroupId) > 0);
    if (!catalog.length) return 0;
    return inTransaction(this.pool, async (client) => {
      for (const group of catalog) {
        await client.query(`
          INSERT INTO ${this.schema}.source_group_catalog(
            source_group_id,name,platform,status,rate_multiplier,sort_order,default_model,source_updated_at,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT(source_group_id) DO UPDATE SET
            name=EXCLUDED.name,platform=EXCLUDED.platform,status=EXCLUDED.status,
            rate_multiplier=EXCLUDED.rate_multiplier,sort_order=EXCLUDED.sort_order,
            default_model=EXCLUDED.default_model,source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`,
        [
          group.sourceGroupId, group.name || '', group.platform || '', group.status || '',
          group.groupMultiplier, group.sortOrder || 0, group.defaultModel || '', group.sourceUpdatedAt || null,
        ]);
      }
      return catalog.length;
    });
  }

  async createMonitorGroup(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO ${this.schema}.monitor_groups(name,source_group_id,model_label,display_order,enabled,created_by)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING *`,
      [input.name,input.sourceGroupId,input.modelLabel,input.displayOrder,input.enabled,actor]);
      const created = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create','monitor_group',$2,$3::jsonb)`,
      [actor,String(created.id),JSON.stringify(created)]);
      return {
        id: number(created.id),
        name: created.name,
        sourceGroupId: number(created.source_group_id),
        modelLabel: created.model_label || '',
        displayOrder: number(created.display_order),
        enabled: Boolean(created.enabled),
      };
    });
  }

  async updateMonitorGroup(id, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const beforeResult = await client.query(
        `SELECT * FROM ${this.schema}.monitor_groups WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!beforeResult.rowCount) throw httpError('monitor group not found', 404);
      const before = beforeResult.rows[0];
      const result = await client.query(`
        UPDATE ${this.schema}.monitor_groups
        SET name=$2,source_group_id=$3,model_label=$4,display_order=$5,enabled=$6,updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id,input.name,input.sourceGroupId,input.modelLabel,input.displayOrder,input.enabled]);
      const updated = result.rows[0];
      if (Number(before.source_group_id) !== Number(updated.source_group_id)) {
        await client.query(`DELETE FROM ${this.schema}.monitor_group_observations WHERE monitor_group_id=$1`, [id]);
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,before_value,after_value)
        VALUES($1,'update','monitor_group',$2,$3::jsonb,$4::jsonb)`,
      [actor,String(id),JSON.stringify(before),JSON.stringify(updated)]);
      return {
        id: number(updated.id),
        name: updated.name,
        sourceGroupId: number(updated.source_group_id),
        modelLabel: updated.model_label || '',
        displayOrder: number(updated.display_order),
        enabled: Boolean(updated.enabled),
      };
    });
  }

  async getPublicMonitorDashboard() {
    const groups = (await this.listMonitorGroups()).filter((group) => group.enabled);
    if (!groups.length) return { generatedAt: new Date().toISOString(), groups: [] };
    const publicGroups = groups.map(({ availableAccountCount: _availableAccountCount, totalAccountCount: _totalAccountCount, ...group }) => group);
    const result = await this.pool.query(`
      WITH ranked AS (
        SELECT monitor_group_id,observed_at,status,
               ROW_NUMBER() OVER (PARTITION BY monitor_group_id ORDER BY observed_at DESC,id DESC) AS row_number
        FROM ${this.schema}.monitor_group_observations
        WHERE monitor_group_id=ANY($1::bigint[])
      )
      SELECT monitor_group_id,observed_at,status
      FROM ranked
      WHERE row_number <= 60
      ORDER BY monitor_group_id,observed_at`,
    [groups.map((group) => group.id)]);
    const history = new Map();
    for (const row of result.rows) {
      const id = number(row.monitor_group_id);
      if (!history.has(id)) history.set(id, []);
      history.get(id).push({
        observedAt: row.observed_at,
        status: row.status,
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      groups: publicGroups.map((group) => ({ ...group, history: history.get(group.id) || [] })),
    };
  }

  async ensureSupplierInTransaction(client, name, actor='admin') {
    const normalized = String(name || '').trim();
    if (!normalized) return null;
    const existing = await client.query(
      `SELECT id FROM ${this.schema}.suppliers WHERE LOWER(name)=LOWER($1) LIMIT 1`,
      [normalized],
    );
    if (existing.rowCount) return Number(existing.rows[0].id);
    const result = await client.query(`
      INSERT INTO ${this.schema}.suppliers(name,created_by,updated_at)
      VALUES($1,$2,NOW()) RETURNING id`,
    [normalized, actor]);
    return Number(result.rows[0].id);
  }

  async ensurePurchaseBatchInTransaction(client, input, supplierId, actor='admin') {
    const batchNumber = String(input.purchaseBatch || '').trim();
    if (!batchNumber) return null;
    const existing = await client.query(`
      SELECT id FROM ${this.schema}.purchase_batches
      WHERE supplier_id IS NOT DISTINCT FROM $1 AND batch_number=$2
      LIMIT 1`, [supplierId, batchNumber]);
    if (existing.rowCount) return Number(existing.rows[0].id);
    const result = await client.query(`
      INSERT INTO ${this.schema}.purchase_batches(
        supplier_id,batch_number,total_amount_cny,fee_amount_cny,tax_amount_cny,
        allocation_strategy,purchased_at,effective_from,effective_to,notes,created_by)
      VALUES($1,$2,0,0,0,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      supplierId,batchNumber,input.allocationStrategy || 'equal',input.effectiveFrom,input.effectiveFrom,input.effectiveTo,
      input.notes || '',actor,
    ]);
    return Number(result.rows[0].id);
  }

  async refreshPurchaseBatchTotalsInTransaction(client, purchaseBatchId) {
    if (!purchaseBatchId) return;
    await client.query(`
      UPDATE ${this.schema}.purchase_batches b
      SET total_amount_cny=COALESCE((
            SELECT SUM(p.base_amount)
            FROM ${this.schema}.account_cost_periods p
            WHERE p.purchase_batch_id=b.id AND p.status <> 'void'
          ),0),
          fee_amount_cny=COALESCE((
            SELECT SUM(p.fee_amount)
            FROM ${this.schema}.account_cost_periods p
            WHERE p.purchase_batch_id=b.id AND p.status <> 'void'
          ),0),
          tax_amount_cny=COALESCE((
            SELECT SUM(p.tax_amount)
            FROM ${this.schema}.account_cost_periods p
            WHERE p.purchase_batch_id=b.id AND p.status <> 'void'
          ),0),
          updated_at=NOW()
      WHERE b.id=$1`, [purchaseBatchId]);
  }

  async upsertAccountCostRule(client, accountId, input, profile, actor='admin') {
    const costMode = input.costMode || profile?.cost_mode || (profile?.cost_type === 'free' ? 'free' : 'fixed_purchase');
    const basisMode = input.basisMode || profile?.basis_mode || 'revenue_backsolve';
    const upstreamMultiplier = input.upstreamMultiplier ?? (
      costMode === 'manual_multiplier' ? profile?.variable_multiplier : null
    );
    const sellingMultiplier = input.sellingMultiplier ?? profile?.default_selling_multiplier ?? null;
    const cnyPerReferenceUnit = input.cnyPerReferenceUnit ?? profile?.cny_per_reference_unit ?? null;
    assertResolvedCostRule({ costMode, basisMode, upstreamMultiplier, sellingMultiplier, cnyPerReferenceUnit });
    await client.query(`
      UPDATE ${this.schema}.account_cost_rules
      SET effective_to=NOW(),status='superseded',updated_at=NOW()
      WHERE source_account_id=$1 AND status='active' AND effective_to IS NULL`,
    [accountId]);
    const result = await client.query(`
      INSERT INTO ${this.schema}.account_cost_rules(
        source_account_id,cost_profile_id,cost_mode,basis_mode,upstream_multiplier,
        selling_multiplier,cny_per_reference_unit,effective_from,status,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),'active',$8,$9) RETURNING *`,
    [
      accountId,input.costProfileId || profile?.id || null,costMode,basisMode,
      upstreamMultiplier,sellingMultiplier,cnyPerReferenceUnit,input.notes || '',actor,
    ]);
    return result.rows[0];
  }

  async createAccountCostPeriod(input, actor='admin') {
    return inTransaction(this.pool, (client) => this.createAccountCostPeriodInTransaction(client, input, actor));
  }

  async createAccountCostPeriodInTransaction(client, input, actor='admin') {
    const account = await client.query(`SELECT a.source_account_id,a.cost_profile_id,cp.cost_type,cp.cost_mode,
        active_rule.cost_mode AS active_rule_cost_mode
      FROM ${this.schema}.dim_accounts a
      LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      LEFT JOIN LATERAL (
        SELECT r.cost_mode
        FROM ${this.schema}.account_cost_rules r
        WHERE r.source_account_id=a.source_account_id AND r.status='active'
          AND (r.effective_to IS NULL OR r.effective_to > NOW())
        ORDER BY r.effective_from DESC,r.id DESC LIMIT 1
      ) active_rule ON TRUE
      WHERE a.source_account_id=$1 FOR UPDATE OF a`, [input.accountId]);
    if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
    let selectedCostType = account.rows[0].cost_type;
    let selectedCostMode = account.rows[0].active_rule_cost_mode || account.rows[0].cost_mode;
    let selectedCostProfileId = account.rows[0].cost_profile_id;
    let selectedProfile = null;
    if (input.costProfileId) {
      const profile = await client.query(`SELECT * FROM ${this.schema}.cost_profiles WHERE id=$1`, [input.costProfileId]);
      if (!profile.rowCount) throw httpError('cost profile not found', 404);
      selectedCostType = profile.rows[0].cost_type;
      selectedCostMode = profile.rows[0].cost_mode;
      selectedCostProfileId = profile.rows[0].id;
      selectedProfile = profile.rows[0];
    }
    if (account.rows[0].active_rule_cost_mode && account.rows[0].active_rule_cost_mode !== 'fixed_purchase') {
      throw httpError('change the account ledger to fixed_purchase before registering a fixed cost period', 409);
    }
    if (selectedCostType === 'free' || selectedCostMode === 'free') throw httpError('free accounts cannot have a CNY cost period', 409);
    if (selectedCostMode && selectedCostMode !== 'fixed_purchase') {
      throw httpError('multiplier accounts use the account ledger rule instead of a fixed cost period', 409);
    }
    const supplierId = input._supplierId ?? await this.ensureSupplierInTransaction(client, input.supplier, actor);
    const purchaseBatchId = input._purchaseBatchId ?? await this.ensurePurchaseBatchInTransaction(client, input, supplierId, actor);
    const totalCost = cnySum(input.baseAmount, input.feeAmount, input.taxAmount);
    const result = await client.query(`
      INSERT INTO ${this.schema}.account_cost_periods(
        source_account_id,cost_profile_id,supplier,purchase_batch,supplier_id,purchase_batch_id,
        original_amount,original_currency,fx_rate,base_amount,fee_amount,tax_amount,allocated_cost_cny,
        effective_from,effective_to,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [
      input.accountId,selectedCostProfileId||null,input.supplier||'',input.purchaseBatch||'',supplierId,purchaseBatchId,
      input.originalAmount,input.originalCurrency,input.fxRate||1,input.baseAmount,input.feeAmount||0,input.taxAmount||0,
      totalCost,input.effectiveFrom,input.effectiveTo,input.notes||'',actor,
    ]);
    const created = result.rows[0];
    if (purchaseBatchId) {
      await client.query(`
        INSERT INTO ${this.schema}.purchase_batch_allocations(
          purchase_batch_id,source_account_id,allocated_amount_cny,effective_from,effective_to,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(purchase_batch_id,source_account_id) DO UPDATE SET
          allocated_amount_cny=EXCLUDED.allocated_amount_cny,effective_from=EXCLUDED.effective_from,
          effective_to=EXCLUDED.effective_to,notes=EXCLUDED.notes,updated_at=NOW()`,
      [purchaseBatchId,input.accountId,totalCost,input.effectiveFrom,input.effectiveTo,input.notes||'',actor]);
      await this.refreshPurchaseBatchTotalsInTransaction(client, purchaseBatchId);
    }
    await client.query(`UPDATE ${this.schema}.dim_accounts SET
      cost_profile_id=COALESCE($2,cost_profile_id),supplier=COALESCE(NULLIF($3,''),supplier),
      purchase_batch=COALESCE(NULLIF($4,''),purchase_batch),
      tags=CASE WHEN $5::jsonb IS NULL THEN tags ELSE $5::jsonb END,synced_at=NOW()
      WHERE source_account_id=$1`, [input.accountId,input.costProfileId||null,input.supplier||'',input.purchaseBatch||'',Array.isArray(input.tags)?JSON.stringify(input.tags):null]);
    await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
      VALUES($1,'create','account_cost_period',$2,$3::jsonb)`, [actor,String(created.id),JSON.stringify(created)]);
    return created;
  }

  async createBulkAccountCostPeriods(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const weights = {};
      if (input.allocationStrategy !== 'equal') {
        const weightColumn = input.allocationStrategy === 'token_weight'
          ? '(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)'
          : 'standard_cost_usd_reference';
        const result = await client.query(`
          SELECT source_account_id,COALESCE(SUM(${weightColumn}),0) AS weight
          FROM ${this.schema}.fact_usage_events
          WHERE source_account_id=ANY($1::bigint[])
            AND occurred_at >= $2 AND occurred_at < $3
          GROUP BY source_account_id`,
        [input.accountIds,input.effectiveFrom,input.effectiveTo]);
        for (const row of result.rows) weights[Number(row.source_account_id)] = row.weight;
      }
      const originalAllocations = splitFixedCostCny(input.originalAmount, input.accountIds, input.allocationStrategy, weights);
      const feeAllocations = splitFixedCostCny(input.feeAmount, input.accountIds, input.allocationStrategy, weights);
      const taxAllocations = splitFixedCostCny(input.taxAmount, input.accountIds, input.allocationStrategy, weights);
      const allocationByAccount = new Map(originalAllocations.map((item, index) => [
        item.accountId,
        {
          originalAmount: item.amountCny,
          feeAmount: feeAllocations[index].amountCny,
          taxAmount: taxAllocations[index].amountCny,
        },
      ]));
      const supplierId = await this.ensureSupplierInTransaction(client, input.supplier, actor);
      const purchaseBatchId = await this.ensurePurchaseBatchInTransaction(client, input, supplierId, actor);
      const periods = [];
      for (const accountId of input.accountIds) {
        const allocation = allocationByAccount.get(accountId);
        periods.push(await this.createAccountCostPeriodInTransaction(client, {
          ...input,
          ...allocation,
          accountId,
          baseAmount: allocation.originalAmount,
          _supplierId: supplierId,
          _purchaseBatchId: purchaseBatchId,
        }, actor));
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create_bulk','account_cost_period',$2,$3::jsonb)`,
      [
        actor, input.accountIds.join(','),
        JSON.stringify({
          accountIds: input.accountIds,
          periodIds: periods.map((period) => period.id),
          allocationStrategy: input.allocationStrategy,
          originalAmount: input.originalAmount,
          feeAmount: input.feeAmount,
          taxAmount: input.taxAmount,
        }),
      ]);
      return {
        accountIds: input.accountIds,
        created: periods.length,
        periods,
        allocatedTotalCny: number(cnySum(input.originalAmount, input.feeAmount, input.taxAmount)),
      };
    });
  }

  async updateAccountLedger(accountId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const account = await client.query(`SELECT source_account_id FROM ${this.schema}.dim_accounts
        WHERE source_account_id=$1 FOR UPDATE`, [accountId]);
      if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
      let profile = null;
      if (input.costProfileId) {
        const profileResult = await client.query(`SELECT * FROM ${this.schema}.cost_profiles WHERE id=$1`, [input.costProfileId]);
        if (!profileResult.rowCount) throw httpError('cost profile not found', 404);
        profile = profileResult.rows[0];
      }
      const selectedMode = input.costMode || profile?.cost_mode || (profile?.cost_type === 'free' ? 'free' : null);
      if (selectedMode === 'free') {
        const periods = await client.query(`SELECT 1 FROM ${this.schema}.account_cost_periods
          WHERE source_account_id=$1 AND status='active' LIMIT 1`, [accountId]);
        if (periods.rowCount) throw httpError('free accounts cannot retain active CNY cost periods', 409);
      }
      let rule = null;
      if (selectedMode) {
        rule = await this.upsertAccountCostRule(client, accountId, input, profile, actor);
      }
      const result = await client.query(`UPDATE ${this.schema}.dim_accounts
        SET cost_profile_id=$2,supplier=$3,purchase_batch=$4,tags=$5::jsonb,synced_at=NOW()
        WHERE source_account_id=$1 RETURNING *`,
      [accountId, input.costProfileId, input.supplier, input.purchaseBatch, JSON.stringify(input.tags)]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update','account_ledger',$2,$3::jsonb)`,
      [actor, String(accountId), JSON.stringify({ account: result.rows[0], rule })]);
      return { ...result.rows[0], costRule: rule };
    });
  }

  async updateAccountCostPeriod(periodId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const existing = await client.query(`SELECT p.source_account_id,p.purchase_batch_id,
          a.cost_profile_id AS account_cost_profile_id
        FROM ${this.schema}.account_cost_periods p
        JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        WHERE p.id=$1 FOR UPDATE OF p,a`, [periodId]);
      if (!existing.rowCount) throw httpError('account cost period not found', 404);
      let selectedCostProfileId = input.costProfileId || existing.rows[0].account_cost_profile_id || null;
      if (input.costProfileId) {
        const profile = await client.query(`SELECT cost_type,cost_mode FROM ${this.schema}.cost_profiles WHERE id=$1`, [input.costProfileId]);
        if (!profile.rowCount) throw httpError('cost profile not found', 404);
        if (profile.rows[0].cost_type === 'free' || profile.rows[0].cost_mode !== 'fixed_purchase') {
          throw httpError('only fixed_purchase profiles can have a CNY cost period', 409);
        }
      }
      const supplierId = await this.ensureSupplierInTransaction(client, input.supplier, actor);
      const purchaseBatchId = await this.ensurePurchaseBatchInTransaction(client, input, supplierId, actor);
      const totalCost = cnySum(input.baseAmount, input.feeAmount, input.taxAmount);
      const result = await client.query(`UPDATE ${this.schema}.account_cost_periods SET
        cost_profile_id=$2,supplier=$3,purchase_batch=$4,supplier_id=$5,purchase_batch_id=$6,
        original_amount=$7,original_currency=$8,fx_rate=$9,
        base_amount=$10,fee_amount=$11,tax_amount=$12,allocated_cost_cny=$13,
        effective_from=$14,effective_to=$15,notes=$16,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [
        periodId,selectedCostProfileId,input.supplier,input.purchaseBatch,supplierId,purchaseBatchId,
        input.originalAmount,input.originalCurrency,input.fxRate,input.baseAmount,input.feeAmount,input.taxAmount,
        totalCost,input.effectiveFrom,input.effectiveTo,input.notes,
      ]);
      if (purchaseBatchId) {
        await client.query(`
          INSERT INTO ${this.schema}.purchase_batch_allocations(
            purchase_batch_id,source_account_id,allocated_amount_cny,effective_from,effective_to,notes,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(purchase_batch_id,source_account_id) DO UPDATE SET
            allocated_amount_cny=EXCLUDED.allocated_amount_cny,effective_from=EXCLUDED.effective_from,
            effective_to=EXCLUDED.effective_to,notes=EXCLUDED.notes,updated_at=NOW()`,
        [purchaseBatchId,existing.rows[0].source_account_id,totalCost,input.effectiveFrom,input.effectiveTo,input.notes||'',actor]);
      }
      const previousPurchaseBatchId = existing.rows[0].purchase_batch_id ? Number(existing.rows[0].purchase_batch_id) : null;
      if (previousPurchaseBatchId && previousPurchaseBatchId !== purchaseBatchId) {
        await client.query(`DELETE FROM ${this.schema}.purchase_batch_allocations
          WHERE purchase_batch_id=$1 AND source_account_id=$2`,
        [previousPurchaseBatchId,existing.rows[0].source_account_id]);
        await this.refreshPurchaseBatchTotalsInTransaction(client, previousPurchaseBatchId);
      }
      if (purchaseBatchId) await this.refreshPurchaseBatchTotalsInTransaction(client, purchaseBatchId);
      await client.query(`UPDATE ${this.schema}.dim_accounts SET
        cost_profile_id=COALESCE($2,cost_profile_id),supplier=$3,purchase_batch=$4,
        tags=CASE WHEN $5::jsonb IS NULL THEN tags ELSE $5::jsonb END,synced_at=NOW()
        WHERE source_account_id=$1`,
      [existing.rows[0].source_account_id, input.costProfileId, input.supplier, input.purchaseBatch,
        Array.isArray(input.tags) ? JSON.stringify(input.tags) : null]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update','account_cost_period',$2,$3::jsonb)`, [actor, String(periodId), JSON.stringify(result.rows[0])]);
      return result.rows[0];
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
      ...cursorResult.rows.map((row) => row.source_name).filter((sourceName) => (
        sourceName !== 'user_subscriptions' && !REQUIRED_SYNC_SOURCES.includes(sourceName)
      )),
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
