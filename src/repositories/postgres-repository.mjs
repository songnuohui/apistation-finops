import { inTransaction } from '../db.mjs';
import Decimal from 'decimal.js/decimal.mjs';
import { calculateMultiplierCostCny, splitFixedCostCny } from '../services/cost-accounting.mjs';

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function supplierConnection(row, { includeCiphertext = false } = {}) {
  if (!row) return null;
  const result = {
    id: Number(row.id),
    supplierId: Number(row.supplier_id),
    supplierName: row.supplier_name || '',
    name: row.name || '',
    adapterType: row.adapter_type || 'auto',
    detectedAdapterType: row.detected_adapter_type || '',
    baseUrl: row.base_url || '',
    authMode: row.auth_mode || 'password',
    credentialLabel: row.credential_label || '',
    credentialsConfigured: Boolean(row.credentials_ciphertext),
    enabled: Boolean(row.enabled),
    inventoryIntervalMinutes: Number(row.inventory_interval_minutes || 10),
    activeCheckEnabled: Boolean(row.active_check_enabled),
    activeCheckLimit: Number(row.active_check_limit || 20),
    lowBalanceThreshold: nullableNumber(row.low_balance_threshold),
    balanceCurrency: row.balance_currency || 'USD',
    connectionStatus: row.connection_status || 'pending',
    lastSyncAt: row.last_sync_at || null,
    lastSuccessAt: row.last_success_at || null,
    nextSyncAt: row.next_sync_at || null,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastError: row.last_error || '',
    balance: nullableNumber(row.balance),
    keyCount: Number(row.key_count || 0),
    activeKeyCount: Number(row.active_key_count || 0),
    failedKeyCount: Number(row.failed_key_count || 0),
    openAlertCount: Number(row.open_alert_count || 0),
    updatedAt: row.updated_at || null,
  };
  if (includeCiphertext) result.credentialsCiphertext = row.credentials_ciphertext || '';
  return result;
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

function assertResolvedCostRule({ costMode, basisMode, upstreamMultiplier, cnyPerReferenceUnit }) {
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
      SELECT COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND status <> 'void'),0) AS inflow,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='in' AND transaction_type='recharge' AND status <> 'void'),0) AS recharge_received,
             COALESCE(SUM(base_amount) FILTER (
               WHERE direction='out' AND transaction_type='refund' AND status <> 'void'
                 AND COALESCE(order_type,'') <> 'subscription'
             ),0) AS refunds,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type='gateway_fee'),0) AS gateway_fees,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND transaction_type IN ('account_purchase','supplier_topup','subscription_renewal')),0) AS procurement_spend,
             COALESCE(SUM(base_amount) FILTER (WHERE direction='out' AND status <> 'void'),0) AS outflow
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
    const missing = await this.pool.query(`
      SELECT COUNT(*) AS count
      FROM ${this.schema}.dim_accounts a
      WHERE a.status='active' AND a.source_deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=a.source_account_id
            AND r.status='active'
            AND (r.effective_to IS NULL OR r.effective_to>NOW())
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.schema}.account_cost_periods p
          WHERE p.source_account_id=a.source_account_id
            AND p.status='active'
            AND p.effective_to>NOW()
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.schema}.upstream_billing_snapshots probe
          WHERE probe.source_account_id=a.source_account_id
            AND probe.status='ok'
            AND probe.effective_rate_multiplier>=0
            AND probe.fresh_until>NOW()
        )`);

    const u = usage.rows[0];
    const c = cash.rows[0];
    const userChargeCny = number(u.user_charge_cny);
    const tokenListValueUsd = number(u.token_list_value_usd);
    const cost = costs.rows[0];
    const purchaseAllocatedCostCny = number(cost.fixed_cost_cny);
    const multiplierCostCny = number(cost.multiplier_cost_cny);
    const effectiveCost = number(cost.effective_cost_cny);
    const grossProfitCny = userChargeCny - effectiveCost;
    const received = number(c.inflow);
    const rechargeReceived = number(c.recharge_received);
    const refunds = number(c.refunds);
    const gatewayFees = number(c.gateway_fees);
    const procurementSpend = number(c.procurement_spend);
    const outflow = number(c.outflow);
    const missingCount = number(missing.rows[0].count);
    const unbookedAccountCount = number(cost.unbooked_account_count);
    const unbookedUserChargeCny = number(cost.unbooked_user_charge_cny);
    const costConflictCount = 0;
    const alerts = [];
    if (missingCount) alerts.push({
      severity: 'high',
      title: `${missingCount} 个账号缺少成本规则`,
      detail: '请在账号成本中心选择固定采购、自动探测或手动上游倍率',
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
        received, rechargeReceived, totalReceived: received,
        refunds, gatewayFees, procurementSpend,
        outflow, netInflow: received - outflow,
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

  async getOverviewDashboard({ start, end, dailyStart = start, dailyEnd = end }) {
    const [summary, totals, tokenUsage, cashRecharge, requestActivity] = await Promise.all([
      this.getSummary({ start, end }),
      this.pool.query(`
        SELECT
          COALESCE(SUM(credit_amount) FILTER (
            WHERE direction='in'
              AND event_type IN ('admin_adjustment','redeem','affiliate_rebate')
              AND COALESCE(cash_basis_cny,0)=0
              AND COALESCE(metadata->>'accounting_scope','') <> 'affiliate_quota'
          ),0) AS gift_balance_credit_cny,
          COUNT(*) FILTER (
            WHERE direction='in'
              AND event_type IN ('admin_adjustment','redeem','affiliate_rebate')
              AND COALESCE(cash_basis_cny,0)=0
              AND COALESCE(metadata->>'accounting_scope','') <> 'affiliate_quota'
          ) AS gift_balance_credit_count,
          (SELECT COALESCE(SUM(current_balance) FILTER (WHERE current_balance > 0 AND NOT exclude_from_balance_stats),0) FROM ${this.schema}.dim_users) AS balance_cny,
          (SELECT COUNT(*) FILTER (WHERE current_balance > 0 AND NOT exclude_from_balance_stats) FROM ${this.schema}.dim_users) AS balance_user_count
        FROM ${this.schema}.credit_events e
        LEFT JOIN ${this.schema}.dim_users credit_user ON credit_user.source_user_id=e.source_user_id
        WHERE e.occurred_at >= $1 AND e.occurred_at < $2
          AND NOT COALESCE(credit_user.exclude_from_balance_stats,FALSE)`,
      [start, end]),
      this.pool.query(`
        SELECT u.source_user_id AS id,u.email,u.username,
               COALESCE(SUM(d.input_tokens+d.output_tokens+d.cache_creation_tokens+d.cache_read_tokens),0)::float8 AS tokens,
               COALESCE(SUM(d.requests),0)::float8 AS requests
        FROM ${this.schema}.fact_usage_daily d
        JOIN ${this.schema}.dim_users u ON u.source_user_id=d.source_user_id
        WHERE d.day >= $1::date AND d.day <= $2::date AND d.source_user_id <> 0
        GROUP BY u.source_user_id,u.email,u.username
        HAVING COALESCE(SUM(d.input_tokens+d.output_tokens+d.cache_creation_tokens+d.cache_read_tokens),0) > 0
        ORDER BY tokens DESC,u.source_user_id ASC
        LIMIT 8`,
      [dailyStart, dailyEnd]),
      this.pool.query(`
        SELECT u.source_user_id AS id,u.email,u.username,
               COALESCE(SUM(c.base_amount),0) AS cash_paid_cny
        FROM ${this.schema}.cash_transactions c
        JOIN ${this.schema}.dim_users u ON u.source_user_id=c.source_user_id
        WHERE c.transaction_type='recharge' AND c.direction='in' AND c.status <> 'void'
          AND c.occurred_at >= $1 AND c.occurred_at < $2
        GROUP BY u.source_user_id,u.email,u.username
        HAVING COALESCE(SUM(c.base_amount),0) > 0
        ORDER BY cash_paid_cny DESC,u.source_user_id ASC
        LIMIT 8`,
      [start, end]),
      this.pool.query(`
        SELECT u.source_user_id AS id,u.email,u.username,
               COALESCE(SUM(d.requests),0)::float8 AS requests,
               COALESCE(SUM(d.input_tokens+d.output_tokens+d.cache_creation_tokens+d.cache_read_tokens),0)::float8 AS tokens
        FROM ${this.schema}.fact_usage_daily d
        JOIN ${this.schema}.dim_users u ON u.source_user_id=d.source_user_id
        WHERE d.day >= $1::date AND d.day <= $2::date AND d.source_user_id <> 0
        GROUP BY u.source_user_id,u.email,u.username
        HAVING COALESCE(SUM(d.requests),0) > 0
        ORDER BY requests DESC,u.source_user_id ASC
        LIMIT 8`,
      [dailyStart, dailyEnd]),
    ]);
    const total = totals.rows[0] || {};
    const rank = (rows, fields) => rows.map((row) => ({
      id: number(row.id),
      email: row.email || '',
      username: row.username || '',
      ...Object.fromEntries(fields.map((field) => [field, number(row[field])])),
    }));
    return {
      generatedAt: new Date().toISOString(),
      summary,
      totals: {
        giftBalanceCreditCny: number(total.gift_balance_credit_cny),
        giftBalanceCreditCount: number(total.gift_balance_credit_count),
        balanceCny: number(total.balance_cny),
        balanceUserCount: number(total.balance_user_count),
      },
      rankings: {
        tokenUsage: rank(tokenUsage.rows, ['tokens', 'requests']),
        cashRecharge: rank(cashRecharge.rows, ['cash_paid_cny']).map((item) => ({
          id: item.id,
          email: item.email,
          username: item.username,
          cashPaidCny: item.cash_paid_cny,
        })),
        requestActivity: rank(requestActivity.rows, ['requests', 'tokens']),
      },
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

  async getUsageBreakdown({
    start, end, dailyStart = start, dailyEnd = end, page = 1, pageSize = 20, offset = 0,
    sort = 'userChargeCny', direction = 'desc',
  }) {
    const sortColumns = {
      userChargeCny: 'revenue_cny',
      requests: 'requests',
      tokens: 'tokens',
      bookedCostCny: 'effective_cost_cny',
      bookedProfitCny: 'profit_cny',
    };
    const orderColumn = sortColumns[sort] || sortColumns.userChargeCny;
    const orderDirection = direction === 'asc' ? 'ASC' : 'DESC';
    const result = await this.pool.query(`
      WITH usage_by_model_account AS (
        SELECT COALESCE(NULLIF(BTRIM(model),''),'未标注模型') AS model,source_account_id,
               SUM(requests)::float8 AS requests,
               SUM(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens)::float8 AS tokens,
               SUM(standard_cost_usd_reference) AS token_list_value_usd,
               SUM(user_charge_cny) AS charge_cny,
               SUM(user_charge_cny) AS revenue_cny,
               SUM(standard_cost_usd_reference) AS allocation_weight
        FROM ${this.schema}.fact_usage_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY COALESCE(NULLIF(BTRIM(model),''),'未标注模型'),source_account_id
      ), account_weight AS (
        SELECT source_account_id,SUM(allocation_weight) AS allocation_weight,SUM(tokens) AS token_weight,SUM(requests) AS request_weight
        FROM usage_by_model_account GROUP BY source_account_id
      ), multiplier_cost AS (
        SELECT COALESCE(NULLIF(BTRIM(f.model),''),NULLIF(BTRIM(f.requested_model),''),
                 NULLIF(BTRIM(f.upstream_model),''),'未标注模型') AS model,
               snapshot.source_account_id,
               COALESCE(SUM(snapshot.calculated_cost_cny) FILTER (WHERE snapshot.cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(snapshot.user_charge_cny) FILTER (
                  WHERE snapshot.cost_status NOT IN ('priced','free','fixed_cost')
                ),0) AS unpriced_user_charge_cny,
               MAX(snapshot.cost_mode) AS cost_mode
        FROM ${this.schema}.usage_cost_facts snapshot
        JOIN ${this.schema}.fact_usage_events f ON f.source_usage_id=snapshot.source_usage_id
        WHERE snapshot.occurred_at >= $3 AND snapshot.occurred_at < $4
        GROUP BY COALESCE(NULLIF(BTRIM(f.model),''),NULLIF(BTRIM(f.requested_model),''),
                   NULLIF(BTRIM(f.upstream_model),''),'未标注模型'),snapshot.source_account_id
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
      FROM model_economics ORDER BY ${orderColumn} ${orderDirection} NULLS LAST,model ASC LIMIT $5 OFFSET $6`, [dailyStart, dailyEnd, start, end, pageSize, offset]);
    return pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      name: String(row.name || '').trim() || '未标注模型',
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
      grossMargin: number(row.revenue_cny) ? number(row.profit_cny) / number(row.revenue_cny) : null,
    })), page, pageSize);
  }

  async listUsageEvents({ start, end, search = '', page = 1, pageSize = 20, offset = 0 }) {
    const result = await this.pool.query(`
      SELECT f.source_usage_id,f.request_id,f.occurred_at,
             f.source_user_id,u.email,u.username,
             f.source_account_id,a.name AS account_name,
             f.source_group_id,f.source_channel_id,
             COALESCE(NULLIF(BTRIM(f.model),''),NULLIF(BTRIM(f.requested_model),''),
               NULLIF(BTRIM(f.upstream_model),''),'未标注模型') AS model,
             COALESCE(f.requested_model,'') AS requested_model,
             COALESCE(f.upstream_model,'') AS upstream_model,
             f.billing_mode,f.billing_type,
             f.input_tokens,f.output_tokens,f.cache_creation_tokens,f.cache_read_tokens,
             (f.input_tokens+f.output_tokens+f.cache_creation_tokens+f.cache_read_tokens)::float8 AS total_tokens,
             f.duration_ms,f.first_token_ms,f.standard_cost_usd_reference,
             f.user_charge_cny,f.recognized_revenue_cny,
             snapshot.cost_mode,snapshot.basis_mode,snapshot.cost_status,
             snapshot.calculated_cost_cny,snapshot.selling_multiplier AS source_selling_multiplier,snapshot.upstream_multiplier,
             snapshot.cny_per_reference_unit,snapshot.upstream_multiplier_source,
             snapshot.rate_observation_id,snapshot.snapshot_origin,
             COALESCE(snapshot.finalized,FALSE) AS cost_snapshot_finalized,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.fact_usage_events f
      LEFT JOIN ${this.schema}.dim_users u ON u.source_user_id=f.source_user_id
      LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=f.source_account_id
      LEFT JOIN ${this.schema}.fact_usage_cost_snapshots snapshot
        ON snapshot.source_usage_id=f.source_usage_id
      WHERE f.occurred_at >= $1 AND f.occurred_at < $2
        AND ($3='' OR f.request_id ILIKE '%'||$3||'%'
          OR f.source_usage_id::text ILIKE '%'||$3||'%'
          OR f.model ILIKE '%'||$3||'%'
          OR f.requested_model ILIKE '%'||$3||'%'
          OR f.upstream_model ILIKE '%'||$3||'%'
          OR u.email ILIKE '%'||$3||'%'
          OR u.username ILIKE '%'||$3||'%'
          OR a.name ILIKE '%'||$3||'%')
      ORDER BY f.occurred_at DESC,f.source_usage_id DESC
      LIMIT $4 OFFSET $5`, [start, end, search, pageSize, offset]);
    return pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      sourceUsageId: number(row.source_usage_id),
      requestId: row.request_id || '',
      occurredAt: row.occurred_at,
      userId: number(row.source_user_id),
      email: row.email || '',
      username: row.username || '',
      accountId: number(row.source_account_id),
      accountName: row.account_name || '',
      groupId: number(row.source_group_id),
      channelId: number(row.source_channel_id),
      model: String(row.model || '').trim() || '未标注模型',
      requestedModel: row.requested_model || '',
      upstreamModel: row.upstream_model || '',
      billingMode: row.billing_mode || '',
      billingType: number(row.billing_type),
      inputTokens: number(row.input_tokens),
      outputTokens: number(row.output_tokens),
      cacheCreationTokens: number(row.cache_creation_tokens),
      cacheReadTokens: number(row.cache_read_tokens),
      totalTokens: number(row.total_tokens),
      tokens: number(row.total_tokens),
      durationMs: nullableNumber(row.duration_ms),
      firstTokenMs: nullableNumber(row.first_token_ms),
      standardCostUsdReference: number(row.standard_cost_usd_reference),
      userChargeCny: number(row.user_charge_cny),
      recognizedRevenueCny: number(row.recognized_revenue_cny),
      costMode: row.cost_mode || 'unconfigured',
      basisMode: row.basis_mode || '',
      costStatus: row.cost_status || 'not_snapshotted',
      calculatedCostCny: nullableNumber(row.calculated_cost_cny),
      sourceSellingMultiplier: nullableNumber(row.source_selling_multiplier),
      upstreamMultiplier: nullableNumber(row.upstream_multiplier),
      cnyPerReferenceUnit: nullableNumber(row.cny_per_reference_unit),
      upstreamMultiplierSource: row.upstream_multiplier_source || '',
      rateObservationId: nullableNumber(row.rate_observation_id),
      costSnapshotOrigin: row.snapshot_origin || '',
      costSnapshotFinalized: Boolean(row.cost_snapshot_finalized),
    })), page, pageSize);
  }

  async listUsers({
    start, end, dailyStart = start, dailyEnd = end, search = '', page = 1, pageSize = 20, offset = 0,
    sort = 'userChargeCny', direction = 'desc', balanceScope = 'all', consumptionOnly = false,
  }) {
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
             u.exclude_from_balance_stats,
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
           AND (NOT $9::boolean OR COALESCE(us.charge_cny,0)>0)
           AND (
             $8='all'
            OR ($8='reported' AND u.current_balance > 0 AND NOT u.exclude_from_balance_stats)
            OR ($8='whitelist' AND u.exclude_from_balance_stats)
          )
      ORDER BY ${orderColumn} ${orderDirection} NULLS LAST,u.source_user_id ASC LIMIT $6 OFFSET $7`, [dailyStart, dailyEnd, start, end, search, pageSize, offset, balanceScope, consumptionOnly]);
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
        excludeFromBalanceStats: Boolean(row.exclude_from_balance_stats),
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
               u.exclude_from_balance_stats,
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
        SELECT source_usage_id,occurred_at,
               COALESCE(NULLIF(BTRIM(model),''),NULLIF(BTRIM(requested_model),''),
                 NULLIF(BTRIM(upstream_model),''),'未标注模型') AS model,
               requested_model,upstream_model,source_account_id,
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
        excludeFromBalanceStats: Boolean(profile.exclude_from_balance_stats),
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
               MAX(upstream_multiplier_source) AS upstream_multiplier_source
        FROM ${this.schema}.usage_cost_facts
        WHERE occurred_at >= $3 AND occurred_at < $4
        GROUP BY source_account_id
      )
      SELECT a.source_account_id AS id,a.name,a.platform,a.supplier,a.purchase_batch,a.status,a.expires_at,
             a.source_deleted_at,a.tags,a.cost_profile_id,
               COALESCE(rule.cost_mode,cp.cost_mode,
                 CASE
                   WHEN cp.cost_type='free' THEN 'free'
                   WHEN COALESCE(c.cost_record_count,0)>0 THEN 'fixed_purchase'
                   WHEN NULLIF(m.cost_mode,'unconfigured') IS NOT NULL THEN m.cost_mode
                   WHEN probe.status='ok' AND probe.effective_rate_multiplier>0 AND probe.fresh_until>NOW() THEN 'probe_multiplier'
                   ELSE 'unconfigured'
                 END
               ) AS cost_type,COALESCE(u.revenue_cny,0) AS revenue_cny,
              COALESCE(u.user_charge_cny,0) AS user_charge_cny,COALESCE(u.token_list_value_usd,0) AS token_list_value_usd,
              COALESCE(c.period_cost,0) AS period_cost_cny,COALESCE(m.multiplier_cost_cny,0) AS multiplier_cost_cny,
              COALESCE(c.period_cost,0)+COALESCE(m.multiplier_cost_cny,0) AS effective_cost_cny,
              COALESCE(m.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny,
               COALESCE(rule.upstream_multiplier,m.upstream_multiplier,
                 CASE WHEN probe.status='ok' AND probe.fresh_until>NOW() THEN probe.effective_rate_multiplier END
               ) AS upstream_multiplier,
               COALESCE(rule.basis_mode,cp.basis_mode,'revenue_backsolve') AS basis_mode,
               COALESCE(rule.cny_per_reference_unit,cp.cny_per_reference_unit) AS cny_per_reference_unit,
               COALESCE(
                 CASE
                   WHEN rule.cost_mode='manual_multiplier' AND rule.upstream_multiplier IS NOT NULL THEN 'manual_rule'
                   WHEN rule.cost_mode='probe_multiplier' AND probe.status='ok' AND probe.fresh_until>NOW() THEN 'probe_snapshot'
                   ELSE NULL
                 END,
                 NULLIF(m.upstream_multiplier_source,''),
                 CASE WHEN probe.status='ok' AND probe.fresh_until>NOW() THEN 'probe_snapshot' ELSE '' END
               ) AS upstream_multiplier_source,
              probe.status AS probe_status,probe.observed_at AS probe_observed_at,probe.fresh_until AS probe_fresh_until,
              COALESCE(c.cost_record_count,0) AS cost_record_count,
              period.id AS current_cost_period_id,period.cost_profile_id AS current_cost_profile_id,
              period.original_amount AS current_original_amount,period.fee_amount AS current_fee_amount,
              period.tax_amount AS current_tax_amount,period.effective_from AS current_effective_from,
              period.effective_to AS current_effective_to,period.notes AS current_cost_notes,
              last_rule.id AS last_cost_rule_id,last_rule.updated_at AS last_cost_rule_changed_at,
              last_rule.created_by AS last_cost_rule_changed_by,
              archive.cutoff_at AS archived_through,
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
        SELECT r.id,r.updated_at,r.created_by
        FROM ${this.schema}.account_cost_rules r
        WHERE r.source_account_id=a.source_account_id
        ORDER BY r.updated_at DESC,r.id DESC LIMIT 1
      ) last_rule ON TRUE
      LEFT JOIN LATERAL (
        SELECT archived.cutoff_at
        FROM ${this.schema}.account_cost_archives archived
        WHERE archived.source_account_id=a.source_account_id
        ORDER BY archived.cutoff_at DESC,archived.id DESC LIMIT 1
      ) archive ON TRUE
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
        basisMode: row.basis_mode || 'revenue_backsolve',
        cnyPerReferenceUnit: number(row.cny_per_reference_unit) || null,
        upstreamMultiplierSource: row.upstream_multiplier_source || '',
        probeStatus: row.probe_status || '',
        probeObservedAt: row.probe_observed_at || null,
        probeFreshUntil: row.probe_fresh_until || null,
        lastCostRuleId: row.last_cost_rule_id ? number(row.last_cost_rule_id) : null,
        lastCostRuleChangedAt: row.last_cost_rule_changed_at || null,
        lastCostRuleChangedBy: row.last_cost_rule_changed_by || '',
        archivedThrough: row.archived_through || null,
      };
    }), page, pageSize);
  }

  async listAccountCostRuleHistory({ accountId, page = 1, pageSize = 20, offset = 0 }) {
    const account = await this.pool.query(
      `SELECT source_account_id FROM ${this.schema}.dim_accounts WHERE source_account_id=$1`,
      [accountId],
    );
    if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
    const result = await this.pool.query(`
      WITH history AS (
        SELECT
          'rule'::text AS event_type,r.id AS event_id,r.effective_from AS occurred_at,
          r.updated_at,r.created_by,r.status,r.change_strategy,r.cost_mode,r.basis_mode,
          r.upstream_multiplier,r.selling_multiplier,r.cny_per_reference_unit,
          r.notes,NULL::timestamptz AS cutoff_at,NULL::integer AS usage_snapshot_count,
          NULL::integer AS fixed_cost_snapshot_count,
          r.effective_from AS range_start,r.effective_to AS range_end,
          NULL::numeric AS before_cost_cny,NULL::numeric AS after_cost_cny
        FROM ${this.schema}.account_cost_rules r
        WHERE r.source_account_id=$1
        UNION ALL
        SELECT
          'archive'::text AS event_type,a.id AS event_id,a.cutoff_at AS occurred_at,
          a.created_at AS updated_at,a.created_by,'archived'::varchar AS status,
          NULL::varchar AS change_strategy,NULL::varchar AS cost_mode,NULL::varchar AS basis_mode,
          NULL::numeric AS upstream_multiplier,NULL::numeric AS selling_multiplier,
          NULL::numeric AS cny_per_reference_unit,a.notes,a.cutoff_at,
          a.usage_snapshot_count,a.fixed_cost_snapshot_count,
          NULL::timestamptz AS range_start,NULL::timestamptz AS range_end,
          NULL::numeric AS before_cost_cny,NULL::numeric AS after_cost_cny
        FROM ${this.schema}.account_cost_archives a
        WHERE a.source_account_id=$1
        UNION ALL
        SELECT
          'reprice'::text AS event_type,j.id AS event_id,j.created_at AS occurred_at,
          j.created_at AS updated_at,j.created_by,'repriced'::varchar AS status,
          'historical_correction'::varchar AS change_strategy,j.cost_mode,j.basis_mode,
          j.upstream_multiplier,j.selling_multiplier,j.cny_per_reference_unit,
          j.notes,NULL::timestamptz AS cutoff_at,j.affected_usage_count,
          NULL::integer AS fixed_cost_snapshot_count,
          j.effective_from AS range_start,j.effective_to AS range_end,
          j.before_cost_cny,j.after_cost_cny
        FROM ${this.schema}.account_cost_reprice_jobs j
        WHERE j.source_account_id=$1
      )
      SELECT *,COUNT(*) OVER() AS total_count
      FROM history
      ORDER BY occurred_at DESC,updated_at DESC,event_id DESC
      LIMIT $2 OFFSET $3`, [accountId, pageSize, offset]);
    return pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      type: row.event_type,
      id: number(row.event_id),
      occurredAt: row.occurred_at,
      updatedAt: row.updated_at,
      actor: row.created_by || '',
      status: row.status,
      changeStrategy: row.change_strategy || '',
      costMode: row.cost_mode || '',
      basisMode: row.basis_mode || '',
      upstreamMultiplier: nullableNumber(row.upstream_multiplier),
      sellingMultiplier: nullableNumber(row.selling_multiplier),
      cnyPerReferenceUnit: nullableNumber(row.cny_per_reference_unit),
      notes: row.notes || '',
      cutoffAt: row.cutoff_at || null,
      usageSnapshotCount: number(row.usage_snapshot_count),
      fixedCostSnapshotCount: number(row.fixed_cost_snapshot_count),
      rangeStart: row.range_start || null,
      rangeEnd: row.range_end || null,
      beforeCostCny: nullableNumber(row.before_cost_cny),
      afterCostCny: nullableNumber(row.after_cost_cny),
    })), page, pageSize);
  }

  async listAccountCostPeriods({ accountId, page = 1, pageSize = 10, offset = 0 }) {
    const result = await this.pool.query(`
      SELECT p.id,p.source_account_id,p.cost_profile_id,
             COALESCE(cp.name,cp.cost_type,'未绑定模板') AS cost_profile,
             COALESCE(NULLIF(p.supplier,''),NULLIF(a.supplier,''),'未标记供应商') AS supplier,
              COALESCE(NULLIF(p.purchase_batch,''),NULLIF(a.purchase_batch,''),'未标记批次') AS purchase_batch,
              p.original_amount,p.fee_amount,p.tax_amount,p.total_cost_cny,
              p.original_currency,p.effective_from,p.effective_to,p.status,p.notes,
              p.effective_from<=NOW() AS has_started,
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
        hasStarted: Boolean(row.has_started),
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

  async listPurchaseCatalog() {
    const [suppliers, batches] = await Promise.all([
      this.pool.query(`
        SELECT DISTINCT ON (LOWER(name)) name
        FROM (
          SELECT name FROM ${this.schema}.suppliers
          UNION ALL
          SELECT NULLIF(BTRIM(supplier),'') AS name FROM ${this.schema}.dim_accounts
          UNION ALL
          SELECT NULLIF(BTRIM(supplier),'') AS name FROM ${this.schema}.account_cost_periods
        ) source
        WHERE name IS NOT NULL AND name <> ''
        ORDER BY LOWER(name),name`),
      this.pool.query(`
        SELECT DISTINCT ON (LOWER(supplier),purchase_batch) supplier,purchase_batch
        FROM (
          SELECT s.name AS supplier,pb.batch_number AS purchase_batch
          FROM ${this.schema}.purchase_batches pb
          JOIN ${this.schema}.suppliers s ON s.id=pb.supplier_id
          UNION ALL
          SELECT NULLIF(BTRIM(supplier),''),NULLIF(BTRIM(purchase_batch),'')
          FROM ${this.schema}.account_cost_periods
          UNION ALL
          SELECT NULLIF(BTRIM(supplier),''),NULLIF(BTRIM(purchase_batch),'')
          FROM ${this.schema}.dim_accounts
        ) source
        WHERE supplier IS NOT NULL AND supplier <> ''
          AND purchase_batch IS NOT NULL AND purchase_batch <> ''
        ORDER BY LOWER(supplier),purchase_batch`),
    ]);
    return {
      suppliers: suppliers.rows.map((row) => row.name),
      batches: batches.rows.map((row) => ({ supplier: row.supplier, purchaseBatch: row.purchase_batch })),
    };
  }

  async listCashTransactions({ start, end, page = 1, pageSize = 20, offset = 0, search = '', scope = 'all' }) {
    const scopeClause = scope === 'recharge'
      ? "AND (t.transaction_type='recharge' OR (t.transaction_type='refund' AND COALESCE(t.order_type,'') <> 'subscription'))"
      : '';
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
        ${scopeClause}
      ORDER BY t.occurred_at DESC LIMIT $4 OFFSET $5`, [start,end,search,pageSize,offset]), this.pool.query(`
       SELECT COALESCE(SUM(t.base_amount) FILTER (WHERE t.direction='in'),0) AS inflow,
             COALESCE(SUM(t.base_amount) FILTER (WHERE t.direction='in' AND t.transaction_type='recharge'),0) AS recharge_received,
             COALESCE(SUM(t.base_amount) FILTER (WHERE t.direction='out'),0) AS outflow,
             COALESCE(SUM(t.base_amount) FILTER (WHERE t.transaction_type='refund'),0) AS refunds,
             COUNT(*)::int AS transactions
      FROM ${this.schema}.cash_transactions t
      WHERE t.occurred_at >= $1 AND t.occurred_at < $2 AND t.status <> 'void'
        ${scopeClause}`, [start,end])]);
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
      inflow: number(summary.inflow), rechargeReceived: number(summary.recharge_received), outflow: number(summary.outflow), refunds: number(summary.refunds),
      net: number(summary.inflow) - number(summary.outflow), transactions: number(summary.transactions),
    } };
  }

  async listNonCashBalanceCredits({ start, end, page = 1, pageSize = 20, offset = 0 }) {
    const conditions = `e.occurred_at >= $1 AND e.occurred_at < $2
      AND e.direction='in'
      AND e.event_type IN ('admin_adjustment','redeem','affiliate_rebate')
      AND COALESCE(e.cash_basis_cny,0)=0
      AND COALESCE(e.metadata->>'accounting_scope','') <> 'affiliate_quota'
      AND NOT COALESCE(u.exclude_from_balance_stats,FALSE)`;
    const [result, totals] = await Promise.all([this.pool.query(`
      SELECT e.id,e.source_table,e.source_id,e.event_type,e.credit_amount,e.occurred_at,
             COALESCE(e.metadata->>'action','') AS action,
             COALESCE(e.metadata->>'redeem_type','') AS redeem_type,
             COALESCE(u.email,'') AS email,COALESCE(u.username,'') AS username,
             COUNT(*) OVER() AS total_count
      FROM ${this.schema}.credit_events e
      LEFT JOIN ${this.schema}.dim_users u ON u.source_user_id=e.source_user_id
      WHERE ${conditions}
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT $3 OFFSET $4`, [start,end,pageSize,offset]), this.pool.query(`
      SELECT COALESCE(SUM(e.credit_amount),0) AS amount_cny,COUNT(*)::int AS events
      FROM ${this.schema}.credit_events e
      LEFT JOIN ${this.schema}.dim_users u ON u.source_user_id=e.source_user_id
      WHERE ${conditions}`, [start,end])]);
    const paged = pageResult(result.rows.map((row) => ({
      total_count: row.total_count,
      id: number(row.id),
      sourceTable: row.source_table,
      sourceId: row.source_id,
      type: row.event_type,
      amountCny: number(row.credit_amount),
      occurredAt: row.occurred_at,
      action: row.action,
      redeemType: row.redeem_type,
      email: row.email,
      username: row.username,
    })), page, pageSize);
    const summary = totals.rows[0] || {};
    return { ...paged, summary: { amountCny: number(summary.amount_cny), events: number(summary.events) } };
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
             cp.cny_per_reference_unit,
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
          currency,allocation_method,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.name,input.costType,input.costMode,input.basisMode,input.variableMultiplier,
        input.cnyPerReferenceUnit,input.currency,input.allocationMethod,
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
        WHERE observation_source='sub2api_channel_monitor'
          AND observed_at >= NOW() - INTERVAL '7 days'
        GROUP BY monitor_group_id
      ), latest AS (
        SELECT DISTINCT ON (monitor_group_id)
               monitor_group_id,status,available_account_count,total_account_count,
               group_multiplier,user_multiplier,effective_multiplier,average_latency_ms,
               average_ping_latency_ms,source_availability_percent,observed_at
        FROM ${this.schema}.monitor_group_observations
        WHERE observation_source='sub2api_channel_monitor'
        ORDER BY monitor_group_id,observed_at DESC,id DESC
      )
      SELECT g.id,g.name,g.source_group_id,g.model_label,g.display_order,g.enabled,
             l.status,l.available_account_count,l.total_account_count,
             c.rate_multiplier AS configured_group_multiplier,
             l.group_multiplier,l.user_multiplier,l.effective_multiplier,l.average_latency_ms,
             l.average_ping_latency_ms,l.source_availability_percent,l.observed_at,
             r.observation_count,r.available_count
      FROM ${this.schema}.monitor_groups g
      LEFT JOIN ${this.schema}.source_group_catalog c ON c.source_group_id=g.source_group_id
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
      configuredGroupMultiplier: nullableNumber(row.configured_group_multiplier),
      groupMultiplier: nullableNumber(row.group_multiplier),
      userMultiplier: nullableNumber(row.user_multiplier),
      effectiveMultiplier: nullableNumber(row.effective_multiplier),
      averageLatencyMs: nullableNumber(row.average_latency_ms),
      averagePingLatencyMs: nullableNumber(row.average_ping_latency_ms),
      lastObservedAt: row.observed_at || null,
      availabilityPercent: nullableNumber(row.source_availability_percent)
        ?? (row.status && row.status !== 'unknown' && number(row.observation_count)
          ? Number((number(row.available_count) * 100 / number(row.observation_count)).toFixed(2))
          : null),
    }));
  }

  async getMonitorSettings() {
    const result = await this.pool.query(`
      SELECT refresh_interval_seconds
      FROM ${this.schema}.monitor_settings
      WHERE id=TRUE
      LIMIT 1`);
    return {
      refreshIntervalSeconds: result.rowCount
        ? number(result.rows[0].refresh_interval_seconds)
        : 30,
    };
  }

  async updateMonitorSettings(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO ${this.schema}.monitor_settings(id,refresh_interval_seconds,updated_at)
        VALUES(TRUE,$1,NOW())
        ON CONFLICT(id) DO UPDATE SET
          refresh_interval_seconds=EXCLUDED.refresh_interval_seconds,
          updated_at=NOW()
        RETURNING refresh_interval_seconds,updated_at`, [input.refreshIntervalSeconds]);
      await client.query(`
        INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update','monitor_settings','singleton',$2::jsonb)`,
      [actor, JSON.stringify({
        refreshIntervalSeconds: number(result.rows[0].refresh_interval_seconds),
        updatedAt: result.rows[0].updated_at,
      })]);
      return {
        refreshIntervalSeconds: number(result.rows[0].refresh_interval_seconds),
      };
    });
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
        await this.upsertGroupSellingRateRule(client, group);
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

  async upsertGroupSellingRateRule(client, group) {
    const sourceGroupId = Number(group.sourceGroupId);
    const parsed = group.groupMultiplier === null || group.groupMultiplier === undefined || group.groupMultiplier === ''
      ? null
      : new Decimal(group.groupMultiplier);
    const incomingMultiplier = parsed && parsed.isFinite() && parsed.gt(0) ? parsed.toString() : null;
    const current = await client.query(`
      SELECT id,selling_multiplier,effective_from
      FROM ${this.schema}.group_selling_rate_rules
      WHERE source_group_id=$1 AND status='active' AND effective_to IS NULL
      ORDER BY effective_from DESC,id DESC
      LIMIT 1
      FOR UPDATE`, [sourceGroupId]);
    const timing = await client.query(`
      WITH clock AS (
        SELECT NOW() AS now_at,
               date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start
      )
      SELECT
        clock.now_at,
        clock.day_start,
        EXISTS (
          SELECT 1
          FROM ${this.schema}.group_selling_rate_rules r
          WHERE r.source_group_id=$1
            AND r.status IN ('active','superseded')
            AND r.effective_from < clock.day_start
        ) AS has_multiplier_before_today,
        (
          SELECT r.id
          FROM ${this.schema}.group_selling_rate_rules r
          WHERE r.source_group_id=$1
            AND r.status IN ('active','superseded')
            AND r.effective_from >= clock.day_start
            AND r.effective_from < clock.day_start + INTERVAL '1 day'
          ORDER BY r.effective_from,r.id
          LIMIT 1
        ) AS first_today_rule_id
      FROM clock`, [sourceGroupId, this.config.timezone || 'UTC']);
    const clock = timing.rows[0];
    if (!clock.has_multiplier_before_today && clock.first_today_rule_id) {
      await client.query(`
        UPDATE ${this.schema}.group_selling_rate_rules
        SET effective_from=$2,updated_at=$3
        WHERE id=$1 AND effective_from>$2`, [
        clock.first_today_rule_id, clock.day_start, clock.now_at,
      ]);
    }

    const activeRule = current.rows[0] || null;
    const unchanged = Boolean(
      activeRule
      && incomingMultiplier
      && new Decimal(activeRule.selling_multiplier).eq(new Decimal(incomingMultiplier)),
    );
    if (unchanged) return;
    let changedAt = clock.now_at;
    if (activeRule && group.sourceUpdatedAt) {
      const sourceUpdatedAt = new Date(group.sourceUpdatedAt);
      const activeEffectiveFrom = Number(activeRule.id) === Number(clock.first_today_rule_id)
        && !clock.has_multiplier_before_today
        ? new Date(clock.day_start)
        : new Date(activeRule.effective_from);
      const nowAt = new Date(clock.now_at);
      if (
        Number.isFinite(sourceUpdatedAt.getTime())
        && sourceUpdatedAt > activeEffectiveFrom
        && sourceUpdatedAt <= nowAt
      ) {
        changedAt = sourceUpdatedAt.toISOString();
      }
    }
    if (activeRule) {
      await client.query(`
        UPDATE ${this.schema}.group_selling_rate_rules
        SET effective_to=$2,status='superseded',updated_at=$2
        WHERE id=$1`, [activeRule.id, changedAt]);
    }
    if (!incomingMultiplier) return;

    const effectiveFrom = !clock.has_multiplier_before_today && !clock.first_today_rule_id
      ? clock.day_start
      : changedAt;
    await client.query(`
      INSERT INTO ${this.schema}.group_selling_rate_rules(
        source_group_id,selling_multiplier,effective_from,status,created_by)
      VALUES($1,$2,$3,'active','sub2api_read_only_catalog')`, [
      sourceGroupId, incomingMultiplier, effectiveFrom,
    ]);
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
    const [allGroups, settings] = await Promise.all([
      this.listMonitorGroups(),
      this.getMonitorSettings(),
    ]);
    const groups = allGroups.filter((group) => group.enabled);
    if (!groups.length) {
      return {
        generatedAt: new Date().toISOString(),
        refreshIntervalSeconds: settings.refreshIntervalSeconds,
        groups: [],
      };
    }
    const publicGroups = groups.map(({
      availableAccountCount: _availableAccountCount,
      totalAccountCount: _totalAccountCount,
      groupMultiplier: _groupMultiplier,
      userMultiplier: _userMultiplier,
      effectiveMultiplier: _effectiveMultiplier,
      ...group
    }) => group);
    const result = await this.pool.query(`
      WITH ranked AS (
        SELECT monitor_group_id,observed_at,status,
               ROW_NUMBER() OVER (PARTITION BY monitor_group_id ORDER BY observed_at DESC,id DESC) AS row_number
      FROM ${this.schema}.monitor_group_observations
        WHERE monitor_group_id=ANY($1::bigint[])
          AND observation_source='sub2api_channel_monitor'
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
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
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
    const changeStrategy = input.changeStrategy || 'future_only';
    const upstreamMultiplier = input.upstreamMultiplier ?? (
      costMode === 'manual_multiplier' ? profile?.variable_multiplier : null
    );
    const sourceSellingMultiplier = null;
    const cnyPerReferenceUnit = input.cnyPerReferenceUnit ?? profile?.cny_per_reference_unit ?? null;
    assertResolvedCostRule({ costMode, basisMode, upstreamMultiplier, cnyPerReferenceUnit });
    const timing = await client.query(`
      WITH clock AS (
        SELECT NOW() AS now_at,
               date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start
      )
      SELECT
        clock.now_at,
        clock.day_start,
        EXISTS (
          SELECT 1
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=$1
            AND r.status IN ('active','superseded')
            AND r.cost_mode IN ('manual_multiplier','probe_multiplier')
            AND r.effective_from < clock.day_start
        ) AS has_multiplier_before_today,
        (
          SELECT r.id
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=$1
            AND r.status IN ('active','superseded')
            AND r.cost_mode IN ('manual_multiplier','probe_multiplier')
            AND r.effective_from >= clock.day_start
            AND r.effective_from < clock.day_start + INTERVAL '1 day'
          ORDER BY r.effective_from,r.id
          LIMIT 1
        ) AS first_today_multiplier_rule_id
      FROM clock`, [accountId, this.config.timezone || 'UTC']);
    const clock = timing.rows[0];
    const currentRuleResult = await client.query(`
      SELECT *
      FROM ${this.schema}.account_cost_rules
      WHERE source_account_id=$1 AND status='active' AND effective_to IS NULL
      ORDER BY effective_from DESC,id DESC LIMIT 1
      FOR UPDATE`, [accountId]);
    const currentRule = currentRuleResult.rows[0];
    const costProfileId = input.costProfileId || profile?.id || null;
    const sameCurrentRule = currentRule
      && String(currentRule.cost_profile_id || '') === String(costProfileId || '')
      && String(currentRule.cost_mode || '') === String(costMode)
      && String(currentRule.basis_mode || '') === String(basisMode)
      && String(currentRule.upstream_multiplier ?? '') === String(upstreamMultiplier ?? '')
      && String(currentRule.selling_multiplier ?? '') === String(sourceSellingMultiplier ?? '')
      && String(currentRule.cny_per_reference_unit ?? '') === String(cnyPerReferenceUnit ?? '')
      && String(currentRule.notes || '') === String(input.notes || '');
    const multiplierMode = ['manual_multiplier', 'probe_multiplier'].includes(costMode);
    if (sameCurrentRule && changeStrategy !== 'current_day') return { ...currentRule, unchanged: true };

    if (changeStrategy === 'current_day' && multiplierMode) {
      const archive = await client.query(`
        SELECT cutoff_at
        FROM ${this.schema}.account_cost_archives
        WHERE source_account_id=$1 AND cutoff_at>$2
        ORDER BY cutoff_at DESC,id DESC LIMIT 1
        FOR UPDATE`, [accountId, clock.day_start]);
      if (archive.rowCount) {
        throw httpError('today has archived pricing; use future_only or create an audited historical correction', 409);
      }
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET status='void',effective_to=NULL,updated_at=$3
        WHERE source_account_id=$1
          AND status IN ('active','superseded')
          AND effective_from >= $2
          AND effective_from < $2 + INTERVAL '1 day'`, [accountId, clock.day_start, clock.now_at]);
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_to=$2,status='superseded',updated_at=$3
        WHERE source_account_id=$1
          AND status IN ('active','superseded')
          AND effective_from < $2
          AND (effective_to IS NULL OR effective_to>$2)`, [accountId, clock.day_start, clock.now_at]);
    } else if (!clock.has_multiplier_before_today && clock.first_today_multiplier_rule_id) {
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_from=$2,updated_at=$3
        WHERE id=$1 AND effective_from>$2`, [
        clock.first_today_multiplier_rule_id, clock.day_start, clock.now_at,
      ]);
    }
    const firstMultiplierToday = Boolean(clock.first_today_multiplier_rule_id);
    const effectiveFrom = changeStrategy === 'current_day' && multiplierMode
      ? clock.day_start
      : multiplierMode
      && !clock.has_multiplier_before_today
      && !firstMultiplierToday
      ? clock.day_start
      : clock.now_at;
    if (!(changeStrategy === 'current_day' && multiplierMode)) {
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_to=$2,status='superseded',updated_at=$2
        WHERE source_account_id=$1 AND status='active' AND effective_to IS NULL`,
      [accountId, clock.now_at]);
    }
    const result = await client.query(`
      INSERT INTO ${this.schema}.account_cost_rules(
        source_account_id,cost_profile_id,cost_mode,basis_mode,upstream_multiplier,
        selling_multiplier,cny_per_reference_unit,effective_from,status,notes,created_by,change_strategy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11) RETURNING *`,
    [
      accountId,costProfileId,costMode,basisMode,
      upstreamMultiplier,sourceSellingMultiplier,cnyPerReferenceUnit,effectiveFrom,input.notes || '',actor,changeStrategy,
    ]);
    return result.rows[0];
  }

  async archiveAccountCost(accountId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const account = await client.query(`
        SELECT source_account_id
        FROM ${this.schema}.dim_accounts
        WHERE source_account_id=$1
        FOR UPDATE`, [accountId]);
      if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
      const clock = await client.query(`
        SELECT NOW() AS now_at,
               ($1::timestamptz AT TIME ZONE $2)::date AS cutoff_day`,
      [input.cutoffAt, this.config.timezone || 'UTC']);
      const cutoffAt = new Date(input.cutoffAt);
      if (cutoffAt.getTime() > new Date(clock.rows[0].now_at).getTime()) {
        throw httpError('archive cutoff cannot be in the future', 400);
      }
      const previous = await client.query(`
        SELECT cutoff_at
        FROM ${this.schema}.account_cost_archives
        WHERE source_account_id=$1
        ORDER BY cutoff_at DESC,id DESC LIMIT 1
        FOR UPDATE`, [accountId]);
      if (previous.rowCount && cutoffAt.getTime() <= new Date(previous.rows[0].cutoff_at).getTime()) {
        throw httpError('archive cutoff must be later than the existing archive', 409);
      }
      const usage = await client.query(`
        UPDATE ${this.schema}.fact_usage_cost_snapshots
        SET finalized=TRUE,finalized_at=COALESCE(finalized_at,NOW())
        WHERE source_account_id=$1 AND finalized=FALSE AND occurred_at<$2`,
      [accountId, input.cutoffAt]);
      const fixed = await client.query(`
        UPDATE ${this.schema}.account_cost_daily_snapshots
        SET finalized=TRUE,finalized_at=COALESCE(finalized_at,NOW()),updated_at=NOW()
        WHERE source_account_id=$1 AND finalized=FALSE AND day<$2::date`,
      [accountId, clock.rows[0].cutoff_day]);
      const created = await client.query(`
        INSERT INTO ${this.schema}.account_cost_archives(
          source_account_id,cutoff_at,usage_snapshot_count,fixed_cost_snapshot_count,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [accountId,input.cutoffAt,usage.rowCount,fixed.rowCount,input.notes || '',actor]);
      await client.query(`
        INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'archive_pricing','account_cost_archive',$2,$3::jsonb)`,
      [actor,String(accountId),JSON.stringify(created.rows[0])]);
      return {
        id: number(created.rows[0].id),
        accountId,
        cutoffAt: created.rows[0].cutoff_at,
        usageSnapshotCount: usage.rowCount,
        fixedCostSnapshotCount: fixed.rowCount,
      };
    });
  }

  async repriceAccountCost(accountId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const account = await client.query(`
        SELECT source_account_id
        FROM ${this.schema}.dim_accounts
        WHERE source_account_id=$1
        FOR UPDATE`, [accountId]);
      if (!account.rowCount) throw httpError('account not found; run synchronization first', 404);
      const snapshots = await client.query(`
        SELECT source_usage_id,user_charge_cny,standard_cost_usd_reference,source_selling_multiplier,calculated_cost_cny
        FROM ${this.schema}.fact_usage_cost_snapshots
        WHERE source_account_id=$1 AND occurred_at >= $2 AND occurred_at < $3
        ORDER BY occurred_at,source_usage_id
        FOR UPDATE`, [accountId,input.effectiveFrom,input.effectiveTo]);
      const beforeCostCny = cnySum(...snapshots.rows.map((row) => row.calculated_cost_cny || 0));
      const repriced = snapshots.rows.map((row) => {
        const calculation = calculateMultiplierCostCny({
          mode: input.costMode,
          basisMode: input.basisMode,
          userChargeCny: row.user_charge_cny,
          standardCostReference: row.standard_cost_usd_reference,
          sourceSellingMultiplier: row.source_selling_multiplier,
          upstreamMultiplier: input.upstreamMultiplier,
          cnyPerReferenceUnit: input.cnyPerReferenceUnit,
        });
        return {
          sourceUsageId: row.source_usage_id,
          costMode: input.costMode,
          basisMode: input.basisMode,
          upstreamMultiplier: input.upstreamMultiplier,
          sourceSellingMultiplier: row.source_selling_multiplier,
          cnyPerReferenceUnit: input.cnyPerReferenceUnit,
          costStatus: calculation.status,
          calculatedCostCny: calculation.costCny,
        };
      });
      const afterCostCny = cnySum(...repriced.map((row) => row.calculatedCostCny || 0));
      const job = await client.query(`
        INSERT INTO ${this.schema}.account_cost_reprice_jobs(
          source_account_id,effective_from,effective_to,cost_mode,basis_mode,
          upstream_multiplier,selling_multiplier,cny_per_reference_unit,
          affected_usage_count,before_cost_cny,after_cost_cny,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
      [
        accountId,input.effectiveFrom,input.effectiveTo,input.costMode,input.basisMode,
        input.upstreamMultiplier,null,input.cnyPerReferenceUnit,
        repriced.length,beforeCostCny,afterCostCny,input.notes || '',actor,
      ]);
      const jobId = Number(job.rows[0].id);
      const batchSize = 5_000;
      for (let offset = 0; offset < repriced.length; offset += batchSize) {
        const batch = repriced.slice(offset, offset + batchSize);
        const params = [jobId];
        const values = batch.map((row, index) => {
          const base = 2 + index * 8;
          params.push(
            row.sourceUsageId,row.costMode,row.basisMode,row.upstreamMultiplier,row.sourceSellingMultiplier,
            row.cnyPerReferenceUnit,row.costStatus,row.calculatedCostCny,
          );
          return `($${base}::bigint,$${base + 1}::varchar,$${base + 2}::varchar,$${base + 3}::numeric,` +
            `$${base + 4}::numeric,$${base + 5}::numeric,$${base + 6}::varchar,$${base + 7}::numeric)`;
        }).join(',');
        await client.query(`
          UPDATE ${this.schema}.fact_usage_cost_snapshots snapshot
          SET cost_mode=changes.cost_mode,basis_mode=changes.basis_mode,
              account_cost_rule_id=NULL,selling_rate_rule_id=NULL,rate_observation_id=NULL,
              selling_multiplier=changes.selling_multiplier,upstream_multiplier=changes.upstream_multiplier,
              cny_per_reference_unit=changes.cny_per_reference_unit,
              upstream_multiplier_source='audited_reprice',cost_status=changes.cost_status,
              calculated_cost_cny=changes.calculated_cost_cny,pricing_version=pricing_version+1,
              frozen_at=NOW(),finalized=TRUE,finalized_at=COALESCE(finalized_at,NOW()),
              last_reprice_job_id=$1
          FROM (VALUES ${values}) AS changes(
            source_usage_id,cost_mode,basis_mode,upstream_multiplier,selling_multiplier,
            cny_per_reference_unit,cost_status,calculated_cost_cny
          )
          WHERE snapshot.source_usage_id=changes.source_usage_id`, params);
      }
      await client.query(`
        INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'historical_reprice','account_cost_reprice_job',$2,$3::jsonb)`,
      [actor,String(jobId),JSON.stringify(job.rows[0])]);
      return {
        id: jobId,
        accountId,
        effectiveFrom: job.rows[0].effective_from,
        effectiveTo: job.rows[0].effective_to,
        affectedUsageCount: repriced.length,
        beforeCostCny: number(beforeCostCny),
        afterCostCny: number(afterCostCny),
      };
    });
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

  async refreshAccountCostPeriodSnapshots(client, periodId, { rewriteFinalized = false } = {}) {
    await client.query(`
      UPDATE ${this.schema}.account_cost_daily_snapshots snapshot
      SET status='void',updated_at=NOW()
      FROM ${this.schema}.account_cost_periods period
      WHERE snapshot.account_cost_period_id=$1
        AND period.id=$1
        AND (snapshot.day_ended_at <= period.effective_from OR snapshot.day_started_at >= period.effective_to)
        AND (NOT snapshot.finalized OR $2::boolean)`, [periodId, rewriteFinalized]);
    const result = await client.query(`
      WITH period AS (
        SELECT p.id,p.source_account_id,p.cost_profile_id,p.effective_from,p.effective_to,p.status,
               COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount) AS period_total_cost_cny,
               COALESCE(profile.cost_type,'prepaid') AS cost_type,
               COALESCE(profile.allocation_method,'standard_cost_weight') AS allocation_method
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles profile ON profile.id=p.cost_profile_id
        WHERE p.id=$1 AND p.status='active'
      ), daily AS (
        SELECT p.*,gs::date AS day,(gs AT TIME ZONE $2) AS day_started_at,
               ((gs+INTERVAL '1 day') AT TIME ZONE $2) AS day_ended_at
        FROM period p
        CROSS JOIN LATERAL generate_series(
          date_trunc('day',p.effective_from AT TIME ZONE $2),
          date_trunc('day',(p.effective_to-INTERVAL '1 microsecond') AT TIME ZONE $2),
          INTERVAL '1 day'
        ) gs
      ), apportioned AS (
        SELECT d.*,GREATEST(d.effective_from,d.day_started_at) AS overlap_started_at,
               LEAST(d.effective_to,d.day_ended_at) AS overlap_ended_at
        FROM daily d
      )
      INSERT INTO ${this.schema}.account_cost_daily_snapshots(
        day,account_cost_period_id,source_account_id,day_started_at,day_ended_at,cost_profile_id,
        cost_type,cost_mode,allocation_method,period_total_cost_cny,daily_cost_cny,
        effective_from,effective_to,status,snapshot_origin
      )
      SELECT day,id,source_account_id,day_started_at,day_ended_at,cost_profile_id,
             cost_type,'fixed_purchase',allocation_method,period_total_cost_cny,
             CASE WHEN effective_to>effective_from THEN period_total_cost_cny
                * EXTRACT(EPOCH FROM(overlap_ended_at-overlap_started_at))
                / EXTRACT(EPOCH FROM(effective_to-effective_from)) ELSE 0 END,
             effective_from,effective_to,status,'historical_backfill'
      FROM apportioned
      WHERE overlap_ended_at>overlap_started_at
      ON CONFLICT(day,account_cost_period_id) DO UPDATE SET
        source_account_id=EXCLUDED.source_account_id,day_started_at=EXCLUDED.day_started_at,
        day_ended_at=EXCLUDED.day_ended_at,cost_profile_id=EXCLUDED.cost_profile_id,
        cost_type=EXCLUDED.cost_type,cost_mode=EXCLUDED.cost_mode,
        allocation_method=EXCLUDED.allocation_method,period_total_cost_cny=EXCLUDED.period_total_cost_cny,
        daily_cost_cny=EXCLUDED.daily_cost_cny,effective_from=EXCLUDED.effective_from,
        effective_to=EXCLUDED.effective_to,status=EXCLUDED.status,updated_at=NOW()
      WHERE NOT account_cost_daily_snapshots.finalized OR $3::boolean
      RETURNING day,account_cost_period_id`, [periodId, this.config.timezone || 'UTC', rewriteFinalized]);
    return result.rowCount;
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
      if (['manual_multiplier','probe_multiplier','free'].includes(selectedMode)) {
        const periods = await client.query(`SELECT 1 FROM ${this.schema}.account_cost_periods
          WHERE source_account_id=$1 AND status='active' AND effective_to>NOW() LIMIT 1`, [accountId]);
        if (periods.rowCount) {
          throw httpError(
            selectedMode === 'free'
              ? 'free accounts cannot retain active CNY cost periods'
              : 'end the active fixed-cost period before enabling multiplier costs to avoid double-counting',
            409,
          );
        }
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
      const existing = await client.query(`SELECT p.*,a.cost_profile_id AS account_cost_profile_id,
          p.effective_from<=NOW() AS has_started
        FROM ${this.schema}.account_cost_periods p
        JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        WHERE p.id=$1 FOR UPDATE OF p,a`, [periodId]);
      if (!existing.rowCount) throw httpError('account cost period not found', 404);
      const before = existing.rows[0];
      if (before.has_started && !input.correctionReason) {
        throw httpError('started purchase costs require a correctionReason so historical profit changes are explicit', 409);
      }
      let selectedCostProfileId = input.costProfileId || before.cost_profile_id || before.account_cost_profile_id || null;
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
        [purchaseBatchId,before.source_account_id,totalCost,input.effectiveFrom,input.effectiveTo,input.notes||'',actor]);
      }
      const previousPurchaseBatchId = before.purchase_batch_id ? Number(before.purchase_batch_id) : null;
      if (previousPurchaseBatchId && previousPurchaseBatchId !== purchaseBatchId) {
        await client.query(`DELETE FROM ${this.schema}.purchase_batch_allocations
          WHERE purchase_batch_id=$1 AND source_account_id=$2`,
        [previousPurchaseBatchId,before.source_account_id]);
        await this.refreshPurchaseBatchTotalsInTransaction(client, previousPurchaseBatchId);
      }
      if (purchaseBatchId) await this.refreshPurchaseBatchTotalsInTransaction(client, purchaseBatchId);
      await client.query(`UPDATE ${this.schema}.dim_accounts SET
        cost_profile_id=COALESCE($2,cost_profile_id),supplier=$3,purchase_batch=$4,
        tags=CASE WHEN $5::jsonb IS NULL THEN tags ELSE $5::jsonb END,synced_at=NOW()
        WHERE source_account_id=$1`,
      [before.source_account_id, input.costProfileId, input.supplier, input.purchaseBatch,
        Array.isArray(input.tags) ? JSON.stringify(input.tags) : null]);
      const snapshotRows = await this.refreshAccountCostPeriodSnapshots(client, periodId, {
        rewriteFinalized: Boolean(before.has_started),
      });
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,$2,'account_cost_period',$3,$4::jsonb)`, [
        actor, before.has_started ? 'historical_correction' : 'update', String(periodId), JSON.stringify({
          before, after: result.rows[0], correctionReason: input.correctionReason || '', snapshotRows,
        }),
      ]);
      return { ...result.rows[0], historicalCorrection: Boolean(before.has_started), snapshotRows };
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

  async setUserBalanceStatsWhitelist(userId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE ${this.schema}.dim_users
        SET exclude_from_balance_stats=$2,synced_at=NOW()
        WHERE source_user_id=$1
        RETURNING source_user_id,email,username,exclude_from_balance_stats`,
      [userId, input.excludeFromBalanceStats]);
      if (!result.rowCount) throw httpError('user not found; run synchronization first', 404);
      const user = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_balance_statistics_whitelist','user',$2,$3::jsonb)`,
      [actor, String(userId), JSON.stringify({
        sourceUserId: Number(user.source_user_id),
        excludeFromBalanceStats: Boolean(user.exclude_from_balance_stats),
      })]);
      return {
        id: Number(user.source_user_id),
        email: user.email || '',
        username: user.username || '',
        excludeFromBalanceStats: Boolean(user.exclude_from_balance_stats),
      };
    });
  }

  async setBulkUserBalanceStatsWhitelist(input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE ${this.schema}.dim_users
        SET exclude_from_balance_stats=$2,synced_at=NOW()
        WHERE source_user_id=ANY($1::bigint[])
        RETURNING source_user_id`,
      [input.userIds, input.excludeFromBalanceStats]);
      if (result.rowCount !== input.userIds.length) {
        const found = new Set(result.rows.map((row) => Number(row.source_user_id)));
        const missing = input.userIds.filter((id) => !found.has(id));
        throw httpError(`users not found; run synchronization first: ${missing.join(',')}`, 404);
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'bulk_update_balance_statistics_whitelist','user',$2,$3::jsonb)`,
      [actor, input.userIds.join(','), JSON.stringify({
        sourceUserIds: input.userIds,
        excludeFromBalanceStats: input.excludeFromBalanceStats,
      })]);
      return {
        userIds: input.userIds,
        updated: result.rowCount,
        excludeFromBalanceStats: input.excludeFromBalanceStats,
      };
    });
  }

  async listSupplierConnections({ search = '' } = {}) {
    const result = await this.pool.query(`
      SELECT c.*,s.name AS supplier_name,b.balance,
             COALESCE(keys.key_count,0)::int AS key_count,
             COALESCE(keys.active_key_count,0)::int AS active_key_count,
             COALESCE(keys.failed_key_count,0)::int AS failed_key_count,
             COALESCE(alerts.open_alert_count,0)::int AS open_alert_count
      FROM ${this.schema}.supplier_connections c
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      LEFT JOIN LATERAL (
        SELECT balance FROM ${this.schema}.supplier_balance_snapshots
        WHERE connection_id=c.id ORDER BY observed_at DESC,id DESC LIMIT 1
      ) b ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE removed_at IS NULL) AS key_count,
               COUNT(*) FILTER (WHERE removed_at IS NULL AND status='active') AS active_key_count,
               COUNT(*) FILTER (WHERE removed_at IS NULL AND last_check_status='failed') AS failed_key_count
        FROM ${this.schema}.supplier_keys WHERE connection_id=c.id
      ) keys ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS open_alert_count FROM ${this.schema}.supplier_alert_events
        WHERE connection_id=c.id AND status='open'
      ) alerts ON TRUE
      WHERE ($1='' OR s.name ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%'
        OR c.base_url ILIKE '%'||$1||'%' OR c.credential_label ILIKE '%'||$1||'%')
      ORDER BY (c.connection_status='failed') DESC,open_alert_count DESC,s.name,c.name`, [search]);
    return { items: result.rows.map((row) => supplierConnection(row)) };
  }

  async getSupplierConnection(connectionId, { includeCiphertext = false } = {}) {
    const result = await this.pool.query(`
      SELECT c.*,s.name AS supplier_name,b.balance,
             COALESCE(keys.key_count,0)::int AS key_count,
             COALESCE(keys.active_key_count,0)::int AS active_key_count,
             COALESCE(keys.failed_key_count,0)::int AS failed_key_count,
             COALESCE(alerts.open_alert_count,0)::int AS open_alert_count
      FROM ${this.schema}.supplier_connections c
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      LEFT JOIN LATERAL (
        SELECT balance FROM ${this.schema}.supplier_balance_snapshots
        WHERE connection_id=c.id ORDER BY observed_at DESC,id DESC LIMIT 1
      ) b ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE removed_at IS NULL) AS key_count,
               COUNT(*) FILTER (WHERE removed_at IS NULL AND status='active') AS active_key_count,
               COUNT(*) FILTER (WHERE removed_at IS NULL AND last_check_status='failed') AS failed_key_count
        FROM ${this.schema}.supplier_keys WHERE connection_id=c.id
      ) keys ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS open_alert_count FROM ${this.schema}.supplier_alert_events
        WHERE connection_id=c.id AND status='open'
      ) alerts ON TRUE
      WHERE c.id=$1 LIMIT 1`, [connectionId]);
    if (!result.rowCount) throw httpError('supplier connection not found', 404);
    return supplierConnection(result.rows[0], { includeCiphertext });
  }

  async createSupplierConnection(input, credentialsCiphertext, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const supplierId = await this.ensureSupplierInTransaction(client, input.supplierName, actor);
      await client.query(`UPDATE ${this.schema}.suppliers
        SET website_url=$2,supplier_type=$3,updated_at=NOW() WHERE id=$1`,
      [supplierId, input.baseUrl, input.adapterType]);
      let result;
      try {
        result = await client.query(`
          INSERT INTO ${this.schema}.supplier_connections(
            supplier_id,name,adapter_type,base_url,auth_mode,credential_label,credentials_ciphertext,
            enabled,inventory_interval_minutes,active_check_enabled,active_check_limit,
            low_balance_threshold,balance_currency,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
          RETURNING *`, [
          supplierId,input.name,input.adapterType,input.baseUrl,input.authMode,input.credentialLabel,
          credentialsCiphertext,input.enabled,input.inventoryIntervalMinutes,input.activeCheckEnabled,
          input.activeCheckLimit,input.lowBalanceThreshold,input.balanceCurrency,actor,
        ]);
      } catch (error) {
        if (error?.code === '23505') throw httpError('该供应商下已存在同名连接', 409);
        throw error;
      }
      const row = { ...result.rows[0], supplier_name: input.supplierName };
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'create_supplier_connection','supplier_connection',$2,$3::jsonb)`,
      [actor,String(row.id),JSON.stringify({ supplierName: input.supplierName, name: input.name, adapterType: input.adapterType, baseUrl: input.baseUrl })]);
      return supplierConnection(row);
    });
  }

  async updateSupplierConnection(connectionId, input, credentialsCiphertext, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const current = await client.query(`SELECT * FROM ${this.schema}.supplier_connections WHERE id=$1 FOR UPDATE`, [connectionId]);
      if (!current.rowCount) throw httpError('supplier connection not found', 404);
      const supplierId = await this.ensureSupplierInTransaction(client, input.supplierName, actor);
      await client.query(`UPDATE ${this.schema}.suppliers
        SET website_url=$2,supplier_type=$3,updated_at=NOW() WHERE id=$1`,
      [supplierId,input.baseUrl,input.adapterType]);
      let result;
      try {
        result = await client.query(`
          UPDATE ${this.schema}.supplier_connections SET
            supplier_id=$2,name=$3,adapter_type=$4,base_url=$5,auth_mode=$6,credential_label=$7,
            credentials_ciphertext=$8,enabled=$9,inventory_interval_minutes=$10,
            active_check_enabled=$11,active_check_limit=$12,low_balance_threshold=$13,
            balance_currency=$14,connection_status=CASE WHEN $9 THEN 'pending' ELSE 'disabled' END,
            next_sync_at=CASE WHEN $9 THEN NOW() ELSE next_sync_at END,last_error='',updated_by=$15,updated_at=NOW()
          WHERE id=$1 RETURNING *`, [
          connectionId,supplierId,input.name,input.adapterType,input.baseUrl,input.authMode,input.credentialLabel,
          credentialsCiphertext,input.enabled,input.inventoryIntervalMinutes,input.activeCheckEnabled,
          input.activeCheckLimit,input.lowBalanceThreshold,input.balanceCurrency,actor,
        ]);
      } catch (error) {
        if (error?.code === '23505') throw httpError('该供应商下已存在同名连接', 409);
        throw error;
      }
      const row = { ...result.rows[0], supplier_name: input.supplierName };
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_connection','supplier_connection',$2,$3::jsonb)`,
      [actor,String(connectionId),JSON.stringify({ supplierName: input.supplierName, name: input.name, adapterType: input.adapterType, baseUrl: input.baseUrl, enabled: input.enabled })]);
      return supplierConnection(row);
    });
  }

  async listDueSupplierConnections(limit = 5) {
    const result = await this.pool.query(`
      SELECT c.*,s.name AS supplier_name
      FROM ${this.schema}.supplier_connections c JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      WHERE c.enabled AND c.next_sync_at<=NOW()
      ORDER BY c.next_sync_at,c.id LIMIT $1`, [limit]);
    return result.rows.map((row) => supplierConnection(row, { includeCiphertext: true }));
  }

  async recordSupplierSyncFailure(connectionId, error) {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE ${this.schema}.supplier_connections SET
          connection_status=CASE WHEN $2='unsupported_site' OR $2='adapter_required' THEN 'unsupported' ELSE 'failed' END,
          last_sync_at=NOW(),consecutive_failures=consecutive_failures+1,last_error=$3,
          next_sync_at=NOW()+LEAST(INTERVAL '24 hours',
            inventory_interval_minutes*INTERVAL '1 minute' * POWER(2,LEAST(consecutive_failures+1,6))),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [connectionId,error.code || 'sync_failed',String(error.message || '供应商同步失败').slice(0,1000)]);
      if (!result.rowCount) return;
      await client.query(`
        INSERT INTO ${this.schema}.supplier_alert_events(
          connection_id,dedupe_key,alert_type,severity,title,message,details)
        VALUES($1,'connection:sync_failed','sync_failed','critical','供应商连接同步失败',$2,$3::jsonb)
        ON CONFLICT(connection_id,dedupe_key) DO UPDATE SET
          status='open',severity='critical',message=EXCLUDED.message,details=EXCLUDED.details,
          last_seen_at=NOW(),occurrence_count=supplier_alert_events.occurrence_count+1,
          resolved_at=NULL`, [connectionId,String(error.message || '供应商同步失败').slice(0,1000),JSON.stringify({ code: error.code || 'sync_failed', httpStatus: error.httpStatus || 0 })]);
    });
  }

  async recordSupplierSyncSuccess(connectionId, snapshot, checks) {
    return inTransaction(this.pool, async (client) => {
      const connectionResult = await client.query(`SELECT * FROM ${this.schema}.supplier_connections WHERE id=$1 FOR UPDATE`, [connectionId]);
      if (!connectionResult.rowCount) throw httpError('supplier connection not found', 404);
      const connection = connectionResult.rows[0];
      const previousResult = await client.query(`SELECT * FROM ${this.schema}.supplier_keys WHERE connection_id=$1 FOR UPDATE`, [connectionId]);
      const previousByExternalId = new Map(previousResult.rows.map((row) => [row.external_key_id, row]));
      const seen = [];
      const alert = async ({ keyId = null, dedupeKey, type, severity = 'warning', title, message = '', details = {} }) => {
        await client.query(`
          INSERT INTO ${this.schema}.supplier_alert_events(
            connection_id,supplier_key_id,dedupe_key,alert_type,severity,title,message,details)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          ON CONFLICT(connection_id,dedupe_key) DO UPDATE SET
            supplier_key_id=EXCLUDED.supplier_key_id,status='open',severity=EXCLUDED.severity,
            title=EXCLUDED.title,message=EXCLUDED.message,details=EXCLUDED.details,last_seen_at=NOW(),
            occurrence_count=supplier_alert_events.occurrence_count+1,resolved_at=NULL`,
        [connectionId,keyId,dedupeKey,type,severity,title,message,JSON.stringify(details)]);
      };
      const resolveAlert = (dedupeKey) => client.query(`UPDATE ${this.schema}.supplier_alert_events
        SET status='resolved',resolved_at=NOW(),last_seen_at=NOW()
        WHERE connection_id=$1 AND dedupe_key=$2 AND status='open'`, [connectionId,dedupeKey]);

      for (const item of snapshot.keys) {
        seen.push(item.externalId);
        const previous = previousByExternalId.get(item.externalId);
        const keyResult = await client.query(`
          INSERT INTO ${this.schema}.supplier_keys(
            connection_id,external_key_id,name,masked_key,key_fingerprint,status,group_id,group_name,
            rate_multiplier,quota_total,quota_used,quota_remaining,quota_currency,expires_at,last_used_at,
            source_data,last_seen_at,removed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW(),NULL)
          ON CONFLICT(connection_id,external_key_id) DO UPDATE SET
            name=EXCLUDED.name,masked_key=EXCLUDED.masked_key,
            key_fingerprint=CASE WHEN EXCLUDED.key_fingerprint='' THEN ${this.schema}.supplier_keys.key_fingerprint ELSE EXCLUDED.key_fingerprint END,
            status=EXCLUDED.status,group_id=EXCLUDED.group_id,group_name=EXCLUDED.group_name,
            rate_multiplier=EXCLUDED.rate_multiplier,quota_total=EXCLUDED.quota_total,quota_used=EXCLUDED.quota_used,
            quota_remaining=EXCLUDED.quota_remaining,quota_currency=EXCLUDED.quota_currency,
            expires_at=EXCLUDED.expires_at,last_used_at=EXCLUDED.last_used_at,source_data=EXCLUDED.source_data,
            last_seen_at=NOW(),removed_at=NULL,updated_at=NOW()
          RETURNING *`, [
          connectionId,item.externalId,item.name,item.maskedKey,item.keyFingerprint || '',item.status,
          item.groupId,item.groupName,item.rateMultiplier,item.quotaTotal,item.quotaUsed,item.quotaRemaining,
          item.quotaCurrency,item.expiresAt,item.lastUsedAt,JSON.stringify(item.sourceData || {}),
        ]);
        const key = keyResult.rows[0];
        const multiplierChanged = previous && nullableNumber(previous.rate_multiplier) !== nullableNumber(item.rateMultiplier);
        const statusChanged = previous && previous.status !== item.status;
        const groupChanged = previous && (previous.group_id !== item.groupId || previous.group_name !== item.groupName);
        const quotaChanged = previous && nullableNumber(previous.quota_remaining) !== nullableNumber(item.quotaRemaining);
        const changeType = !previous ? 'discovered' : multiplierChanged ? 'multiplier_changed' : statusChanged ? 'status_changed' : groupChanged ? 'group_changed' : quotaChanged ? 'quota_changed' : 'snapshot';
        await client.query(`INSERT INTO ${this.schema}.supplier_key_observations(
          supplier_key_id,status,group_name,rate_multiplier,quota_remaining,change_type,snapshot_data)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [key.id,item.status,item.groupName,item.rateMultiplier,item.quotaRemaining,changeType,JSON.stringify(item.sourceData || {})]);
        if (multiplierChanged) await alert({
          keyId:key.id,dedupeKey:`key:${key.id}:multiplier`,type:'multiplier_changed',title:'密钥倍率发生变化',
          message:`${item.name || item.maskedKey}：${previous.rate_multiplier ?? '--'}x → ${item.rateMultiplier ?? '--'}x`,
          details:{ previous:nullableNumber(previous.rate_multiplier), current:nullableNumber(item.rateMultiplier) },
        });
        if (statusChanged && item.status !== 'active') await alert({
          keyId:key.id,dedupeKey:`key:${key.id}:portal_status`,type:'key_status_changed',title:'密钥状态异常',
          message:`${item.name || item.maskedKey} 当前状态：${item.status}`,details:{ previous:previous.status,current:item.status },
        });
        if (item.status === 'active') await resolveAlert(`key:${key.id}:portal_status`);

        const check = checks.find((candidate) => candidate.externalId === item.externalId);
        if (check) {
          await client.query(`INSERT INTO ${this.schema}.supplier_key_checks(
            supplier_key_id,status,method,http_status,latency_ms,error_code,error_message)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [key.id,check.status,check.method,check.httpStatus || 0,check.latencyMs ?? null,check.errorCode || '',String(check.errorMessage || '').slice(0,1000)]);
          await client.query(`UPDATE ${this.schema}.supplier_keys SET
            last_check_status=$2,last_check_method=$3,last_check_at=NOW(),last_check_error=$4,updated_at=NOW()
            WHERE id=$1`, [key.id,check.status,check.method,String(check.errorMessage || '').slice(0,1000)]);
          if (check.status === 'failed') await alert({
            keyId:key.id,dedupeKey:`key:${key.id}:check`,type:'key_check_failed',severity:'critical',title:'密钥巡检失败',
            message:`${item.name || item.maskedKey}：${check.errorMessage || check.errorCode || '不可用'}`,
            details:{ method:check.method,httpStatus:check.httpStatus || 0,errorCode:check.errorCode || '' },
          });
          if (check.status === 'ok') await resolveAlert(`key:${key.id}:check`);
          if (check.status === 'ok' && check.billing) {
            const links = await client.query(`SELECT source_account_id FROM ${this.schema}.supplier_account_links WHERE supplier_key_id=$1`, [key.id]);
            const observedAt = check.billing.observed_at || new Date().toISOString();
            for (const link of links.rows) await client.query(`
              INSERT INTO ${this.schema}.account_rate_observations(
                source_account_id,observation_key,source_kind,status,billing_scope,observed_at,received_at,
                fresh_until,last_attempt_at,next_probe_at,failure_count,http_status,last_error,
                group_rate_multiplier,user_rate_multiplier,resolved_rate_multiplier,effective_rate_multiplier,
                peak_rate_enabled,peak_rate_multiplier,applied_peak_multiplier,timezone,snapshot_data,supplier_key_id)
              VALUES($1,$2,'supplier_direct_probe','ok','token',$3,NOW(),
                NOW()+($4*2)*INTERVAL '1 minute',NOW(),NOW()+$4*INTERVAL '1 minute',0,$5,'',
                $6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
              ON CONFLICT(source_account_id,observation_key) DO NOTHING`, [
              link.source_account_id,`supplier:${key.id}:${observedAt}`,observedAt,connection.inventory_interval_minutes,
              check.httpStatus || 200,check.billing.group_rate_multiplier,check.billing.user_rate_multiplier,
              check.billing.resolved_rate_multiplier,check.billing.effective_rate_multiplier,
              check.billing.peak_rate_enabled,check.billing.peak_rate_multiplier,check.billing.applied_peak_multiplier,
              check.billing.timezone || '',JSON.stringify(check.billing),key.id,
            ]);
          }
        }
      }

      const removed = previousResult.rows.filter((row) => !seen.includes(row.external_key_id) && !row.removed_at);
      if (seen.length) await client.query(`UPDATE ${this.schema}.supplier_keys
        SET removed_at=NOW(),status='removed',updated_at=NOW()
        WHERE connection_id=$1 AND NOT (external_key_id=ANY($2::text[])) AND removed_at IS NULL`, [connectionId,seen]);
      else await client.query(`UPDATE ${this.schema}.supplier_keys
        SET removed_at=NOW(),status='removed',updated_at=NOW() WHERE connection_id=$1 AND removed_at IS NULL`, [connectionId]);
      for (const key of removed) await alert({
        keyId:key.id,dedupeKey:`key:${key.id}:removed`,type:'key_removed',title:'供应商密钥已移除',
        message:`${key.name || key.masked_key} 已不在供应商返回的密钥列表中`,
      });

      if (snapshot.balance !== null && snapshot.balance !== undefined) {
        await client.query(`INSERT INTO ${this.schema}.supplier_balance_snapshots(connection_id,balance,currency)
          VALUES($1,$2,$3)`, [connectionId,snapshot.balance,snapshot.balanceCurrency]);
        if (connection.low_balance_threshold !== null && Number(snapshot.balance) < Number(connection.low_balance_threshold)) await alert({
          dedupeKey:'connection:low_balance',type:'low_balance',severity:'critical',title:'供应商余额不足',
          message:`当前余额 ${snapshot.balance} ${snapshot.balanceCurrency}，低于阈值 ${connection.low_balance_threshold} ${connection.balance_currency}`,
          details:{ balance:snapshot.balance,currency:snapshot.balanceCurrency,threshold:Number(connection.low_balance_threshold) },
        });
        else await resolveAlert('connection:low_balance');
      }
      await resolveAlert('connection:sync_failed');
      const failedChecks = checks.filter((check) => check.status === 'failed').length;
      await client.query(`UPDATE ${this.schema}.supplier_connections SET
        connection_status=$2,detected_adapter_type=$3,credential_label=COALESCE(NULLIF($4,''),credential_label),
        balance_currency=$5,last_sync_at=NOW(),last_success_at=NOW(),next_sync_at=NOW()+inventory_interval_minutes*INTERVAL '1 minute',
        consecutive_failures=0,last_error='',updated_at=NOW() WHERE id=$1`,
      [connectionId,failedChecks ? 'warning' : 'ok',snapshot.adapterType,snapshot.identity || '',snapshot.balanceCurrency || connection.balance_currency]);
    });
  }

  async getSupplierConnectionDetails(connectionId) {
    const connection = await this.getSupplierConnection(connectionId);
    const [keys,balances,checks,alerts,links,accounts] = await Promise.all([
      this.pool.query(`SELECT id,external_key_id,name,masked_key,status,group_id,group_name,rate_multiplier,
        quota_total,quota_used,quota_remaining,quota_currency,expires_at,last_used_at,last_check_status,
        last_check_method,last_check_at,last_check_error,first_seen_at,last_seen_at,removed_at
        FROM ${this.schema}.supplier_keys WHERE connection_id=$1
        ORDER BY (removed_at IS NULL) DESC,(last_check_status='failed') DESC,name,id`, [connectionId]),
      this.pool.query(`SELECT balance,currency,observed_at FROM ${this.schema}.supplier_balance_snapshots
        WHERE connection_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 60`, [connectionId]),
      this.pool.query(`SELECT c.id,c.supplier_key_id,k.name AS key_name,k.masked_key,c.status,c.method,c.http_status,
        c.latency_ms,c.error_code,c.error_message,c.checked_at
        FROM ${this.schema}.supplier_key_checks c JOIN ${this.schema}.supplier_keys k ON k.id=c.supplier_key_id
        WHERE k.connection_id=$1 ORDER BY c.checked_at DESC,c.id DESC LIMIT 100`, [connectionId]),
      this.pool.query(`SELECT id,supplier_key_id,alert_type,severity,status,title,message,details,first_seen_at,
        last_seen_at,occurrence_count,acknowledged_at,acknowledged_by,resolved_at
        FROM ${this.schema}.supplier_alert_events WHERE connection_id=$1
        ORDER BY (status='open') DESC,last_seen_at DESC,id DESC LIMIT 100`, [connectionId]),
      this.pool.query(`SELECT l.supplier_key_id,l.source_account_id,a.name AS account_name
        FROM ${this.schema}.supplier_account_links l
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
        JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id WHERE k.connection_id=$1`, [connectionId]),
      this.pool.query(`SELECT source_account_id AS id,name,platform,status FROM ${this.schema}.dim_accounts
        WHERE source_deleted_at IS NULL ORDER BY name,source_account_id LIMIT 5000`),
    ]);
    const linksByKey = new Map();
    for (const row of links.rows) {
      if (!linksByKey.has(String(row.supplier_key_id))) linksByKey.set(String(row.supplier_key_id), []);
      linksByKey.get(String(row.supplier_key_id)).push({ accountId:Number(row.source_account_id),accountName:row.account_name || '' });
    }
    return {
      connection,
      keys: keys.rows.map((row) => ({
        id:Number(row.id),externalId:row.external_key_id,name:row.name,maskedKey:row.masked_key,status:row.status,
        groupId:row.group_id,groupName:row.group_name,rateMultiplier:nullableNumber(row.rate_multiplier),
        quotaTotal:nullableNumber(row.quota_total),quotaUsed:nullableNumber(row.quota_used),quotaRemaining:nullableNumber(row.quota_remaining),
        quotaCurrency:row.quota_currency,expiresAt:row.expires_at,lastUsedAt:row.last_used_at,
        lastCheckStatus:row.last_check_status,lastCheckMethod:row.last_check_method,lastCheckAt:row.last_check_at,
        lastCheckError:row.last_check_error,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,removedAt:row.removed_at,
        accountLinks:linksByKey.get(String(row.id)) || [],
      })),
      balances: balances.rows.map((row) => ({ balance:Number(row.balance),currency:row.currency,observedAt:row.observed_at })),
      checks: checks.rows.map((row) => ({
        id:Number(row.id),keyId:Number(row.supplier_key_id),keyName:row.key_name,maskedKey:row.masked_key,status:row.status,
        method:row.method,httpStatus:Number(row.http_status),latencyMs:nullableNumber(row.latency_ms),errorCode:row.error_code,
        errorMessage:row.error_message,checkedAt:row.checked_at,
      })),
      alerts: alerts.rows.map((row) => ({
        id:Number(row.id),keyId:row.supplier_key_id?Number(row.supplier_key_id):null,type:row.alert_type,severity:row.severity,
        status:row.status,title:row.title,message:row.message,details:row.details || {},firstSeenAt:row.first_seen_at,
        lastSeenAt:row.last_seen_at,occurrenceCount:Number(row.occurrence_count),acknowledgedAt:row.acknowledged_at,
        acknowledgedBy:row.acknowledged_by,resolvedAt:row.resolved_at,
      })),
      accounts: accounts.rows.map((row) => ({ id:Number(row.id),name:row.name,platform:row.platform,status:row.status })),
    };
  }

  async setSupplierKeyAccountLink(keyId, accountId, linked, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const key = await client.query(`SELECT id FROM ${this.schema}.supplier_keys WHERE id=$1`, [keyId]);
      if (!key.rowCount) throw httpError('supplier key not found', 404);
      const account = await client.query(`SELECT source_account_id FROM ${this.schema}.dim_accounts WHERE source_account_id=$1`, [accountId]);
      if (!account.rowCount) throw httpError('account not found', 404);
      if (linked) await client.query(`INSERT INTO ${this.schema}.supplier_account_links(supplier_key_id,source_account_id,created_by)
        VALUES($1,$2,$3) ON CONFLICT(source_account_id) DO UPDATE SET supplier_key_id=EXCLUDED.supplier_key_id,created_by=EXCLUDED.created_by,created_at=NOW()`, [keyId,accountId,actor]);
      else await client.query(`DELETE FROM ${this.schema}.supplier_account_links WHERE supplier_key_id=$1 AND source_account_id=$2`, [keyId,accountId]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_account_link','supplier_key',$2,$3::jsonb)`,
      [actor,String(keyId),JSON.stringify({ sourceAccountId:accountId,linked })]);
      return { keyId,accountId,linked };
    });
  }

  async acknowledgeSupplierAlert(alertId, actor='admin') {
    const result = await this.pool.query(`UPDATE ${this.schema}.supplier_alert_events
      SET status='acknowledged',acknowledged_at=NOW(),acknowledged_by=$2,last_seen_at=NOW()
      WHERE id=$1 RETURNING id,status,acknowledged_at,acknowledged_by`, [alertId,actor]);
    if (!result.rowCount) throw httpError('supplier alert not found', 404);
    return { id:Number(result.rows[0].id),status:result.rows[0].status,acknowledgedAt:result.rows[0].acknowledged_at,acknowledgedBy:result.rows[0].acknowledged_by };
  }

  async getRuntimeDashboard() {
    const [queueResult, usersResult] = await Promise.all([
      this.pool.query(`
        SELECT enabled,mode,worker_count,active_workers,idle_workers,queue_size,queue_length,
               queue_usage_percent,processed,errors,observed_at
        FROM ${this.schema}.runtime_queue_live
        WHERE source_name='sub2api_risk_control' LIMIT 1`),
      this.pool.query(`
        SELECT live.source_user_id,
               COALESCE(NULLIF(live.email,''),users.email,'') AS email,
               COALESCE(NULLIF(live.username,''),users.username,'') AS username,
               live.max_concurrency,live.current_concurrency,live.observed_at
        FROM ${this.schema}.user_concurrency_live live
        LEFT JOIN ${this.schema}.dim_users users ON users.source_user_id=live.source_user_id
        ORDER BY live.current_concurrency DESC,live.max_concurrency DESC,live.source_user_id ASC
        LIMIT 100`),
    ]);
    const queue = queueResult.rows[0];
    return {
      queue: queue ? {
        available: true,
        enabled: Boolean(queue.enabled),
        mode: queue.mode || '',
        workerCount: number(queue.worker_count),
        activeWorkers: number(queue.active_workers),
        idleWorkers: number(queue.idle_workers),
        queueSize: number(queue.queue_size),
        queueLength: number(queue.queue_length),
        queueUsagePercent: number(queue.queue_usage_percent),
        processed: number(queue.processed),
        errors: number(queue.errors),
        observedAt: queue.observed_at,
      } : { available: false },
      users: usersResult.rows.map((row) => {
        const maxConcurrency = number(row.max_concurrency);
        const currentConcurrency = number(row.current_concurrency);
        return {
          id: number(row.source_user_id),
          email: row.email || '',
          username: row.username || '',
          maxConcurrency,
          currentConcurrency,
          usagePercent: maxConcurrency > 0 ? Math.min(100, currentConcurrency * 100 / maxConcurrency) : null,
          observedAt: row.observed_at,
        };
      }),
    };
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
