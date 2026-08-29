import { inTransaction } from '../db.mjs';
import Decimal from 'decimal.js/decimal.mjs';
import { calculateMultiplierCostCny, splitFixedCostCny } from '../services/cost-accounting.mjs';
import { buildSupplierQualityScores, normalizeQualityStatus } from '../services/supplier-quality.mjs';
import { profitGuardAlertCopy, supplierUserMessage } from '../services/supplier-messages.mjs';

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function supplierKeyPurchaseBatch(row) {
  const externalId = String(row?.external_key_id ?? row?.externalId ?? '').trim();
  const identity = String(row?.name || '').trim()
    || String(row?.masked_key ?? row?.maskedKey ?? '').trim()
    || (externalId ? `密钥 ${externalId}` : '供应商密钥');
  const suffix = externalId && !identity.includes(externalId) ? ` · ID ${externalId}` : '';
  return `${identity}${suffix}`.slice(0, 120);
}

function supplierConnection(row, { includeCiphertext = false } = {}) {
  if (!row) return null;
  const result = {
    id: Number(row.id),
    supplierId: Number(row.supplier_id),
    supplierName: row.supplier_name || '',
    supplierNotes: row.supplier_notes || '',
    name: row.name || '',
    adapterType: row.adapter_type || 'auto',
    detectedAdapterType: row.detected_adapter_type || '',
    baseUrl: row.base_url || '',
    authMode: row.auth_mode || 'password',
    credentialLabel: row.credential_label || '',
    credentialsConfigured: Boolean(row.credentials_ciphertext),
    enabled: Boolean(row.enabled),
    alertEnabled: row.alert_enabled === undefined ? true : Boolean(row.alert_enabled),
    inventoryIntervalSeconds: Number(row.inventory_interval_seconds || (Number(row.inventory_interval_minutes || 10) * 60)),
    inventoryIntervalMinutes: Number(row.inventory_interval_minutes || Math.ceil(Number(row.inventory_interval_seconds || 600) / 60)),
    activeCheckEnabled: Boolean(row.active_check_enabled),
    activeCheckLimit: Number(row.active_check_limit || 20),
    qualityMonitorMode: row.quality_monitor_mode || 'passive',
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
    profitGuardConfigured: Boolean(row.profit_guard_configured),
    profitGuardEnabled: Boolean(row.profit_guard_enabled),
    profitGuardFullyEnabled: Boolean(row.profit_guard_fully_enabled),
    linkedAccountCount: Number(row.linked_account_count || 0),
    profitGuardConfiguredAccountCount: Number(row.profit_guard_configured_account_count || 0),
    profitGuardAccountCount: Number(row.profit_guard_account_count || 0),
    updatedAt: row.updated_at || null,
  };
  if (includeCiphertext) result.credentialsCiphertext = row.credentials_ciphertext || '';
  return result;
}

function sub2ApiServiceAuthSettings(row, { includeCiphertext = false } = {}) {
  const result = {
    enabled: Boolean(row?.enabled),
    authMode: row?.auth_mode || 'password',
    email: row?.email || '',
    credentialsConfigured: Boolean(row?.credentials_ciphertext),
    lastAuthenticatedAt: row?.last_authenticated_at || null,
    tokenExpiresAt: row?.token_expires_at || null,
    lastError: row?.last_error || '',
    updatedBy: row?.updated_by || '',
    updatedAt: row?.updated_at || null,
  };
  if (includeCiphertext) result.credentialsCiphertext = row?.credentials_ciphertext || '';
  return result;
}

function oauthSupplyAuthSettings(row, { includeCiphertext = false } = {}) {
  const result = {
    enabled: Boolean(row?.enabled),
    baseUrl: row?.base_url || 'https://sogouedu.cc',
    username: row?.username || '',
    credentialsConfigured: Boolean(row?.credentials_ciphertext),
    tokenConfigured: Boolean(row?.token_ciphertext),
    lastAuthenticatedAt: row?.last_authenticated_at || null,
    tokenExpiresAt: row?.token_expires_at || null,
    lastError: row?.last_error || '',
    updatedBy: row?.updated_by || '',
    updatedAt: row?.updated_at || null,
  };
  if (includeCiphertext) {
    result.credentialsCiphertext = row?.credentials_ciphertext || '';
    result.tokenCiphertext = row?.token_ciphertext || '';
  }
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
  'payment_orders', 'redeem_codes', 'user_affiliate_ledger', 'payment_audit_logs',
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
    const [usage, cash, costs, missing] = await Promise.all([
      this.pool.query(`
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
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]),
      this.pool.query(`
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
      WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]),
      this.pool.query(`
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
               COALESCE(SUM(COALESCE(
                 p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount
               )) FILTER (WHERE p.effective_from >= $1 AND p.effective_from < $2),0) AS fixed_cost_cny,
               COUNT(*) AS fixed_cost_record_count
        FROM ${this.schema}.account_cost_periods p
        WHERE p.status='active'
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
      FROM account_costs`, [start, end]),
      this.pool.query(`
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
        )`),
    ]);

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
        SELECT (p.effective_from AT TIME ZONE $3)::date AS day,p.source_account_id,
               SUM(COALESCE(
                 p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount
               )) AS purchase_allocated_cost_cny
        FROM ${this.schema}.account_cost_periods p
        WHERE p.status='active' AND p.effective_from >= $4 AND p.effective_from < $5
        GROUP BY (p.effective_from AT TIME ZONE $3)::date,p.source_account_id
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
               SUM(COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount))
                 FILTER (WHERE p.effective_from >= $3 AND p.effective_from < $4)
                 AS purchase_allocated_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
                 ELSE 0 END) AS effective_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS standard_cost_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS token_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS effective_standard_cost_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS effective_token_weight_cost_cny
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles period_profile ON period_profile.id=p.cost_profile_id
        WHERE p.status='active'
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
               SUM(COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount))
                 FILTER (WHERE p.effective_from >= $3 AND p.effective_from < $4)
                 AS period_cost,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
                 ELSE 0 END) AS effective_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS standard_cost_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS token_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='standard_cost_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS effective_standard_cost_weight_cost_cny,
               SUM(CASE WHEN p.effective_from >= $3 AND p.effective_from < $4
                 AND LOWER(COALESCE(period_profile.allocation_method,'standard_cost_weight'))='token_weight'
                 AND LOWER(COALESCE(period_profile.cost_type,'unconfigured'))<>'free' THEN
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ELSE 0 END) AS effective_token_weight_cost_cny
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles period_profile ON period_profile.id=p.cost_profile_id
        WHERE p.status='active'
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
             jsonb_build_object(
               'userCount',COUNT(*) FILTER (WHERE NOT u.exclude_from_balance_stats) OVER (),
               'excludedUserCount',COUNT(*) FILTER (WHERE u.exclude_from_balance_stats) OVER (),
               'remainingBalanceCny',COALESCE(SUM(u.current_balance) FILTER (
                 WHERE u.current_balance > 0 AND NOT u.exclude_from_balance_stats
               ) OVER (),0),
               'positiveBalanceUserCount',COUNT(*) FILTER (
                 WHERE u.current_balance > 0 AND NOT u.exclude_from_balance_stats
               ) OVER (),
               'cashPaidCny',COALESCE(SUM(COALESCE(c.cash_paid_cny,0)) FILTER (
                 WHERE NOT u.exclude_from_balance_stats
               ) OVER (),0),
               'cashPayingUserCount',COUNT(*) FILTER (
                 WHERE COALESCE(c.cash_paid_cny,0)>0 AND NOT u.exclude_from_balance_stats
               ) OVER (),
               'userChargeCny',COALESCE(SUM(COALESCE(us.charge_cny,0)) FILTER (
                 WHERE NOT u.exclude_from_balance_stats
               ) OVER (),0),
               'requests',COALESCE(SUM(COALESCE(us.requests,0)) FILTER (
                 WHERE NOT u.exclude_from_balance_stats
               ) OVER (),0),
               'bookedCostCny',COALESCE(SUM(COALESCE(us.effective_cost_cny,0)) FILTER (
                 WHERE NOT u.exclude_from_balance_stats
               ) OVER (),0),
               'bookedProfitCny',COALESCE(SUM(
                 COALESCE(us.revenue_cny,0)-COALESCE(us.effective_cost_cny,0)
               ) FILTER (WHERE NOT u.exclude_from_balance_stats) OVER (),0),
               'partialCostUserCount',COUNT(*) FILTER (
                 WHERE COALESCE(us.unbooked_account_count,0)>0 AND NOT u.exclude_from_balance_stats
               ) OVER ()
             ) AS user_finance_summary,
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
    const rawSummary = result.rows[0]?.user_finance_summary || {};
    const userChargeCny = number(rawSummary.userChargeCny);
    const bookedProfitCny = number(rawSummary.bookedProfitCny);
    const resultPage = pageResult(result.rows.map((row) => {
      const recognizedRevenueCny = number(row.revenue_cny);
      const purchaseAllocatedCostCny = number(row.purchase_allocated_cost_cny);
      const effectiveCost = number(row.effective_cost_cny);
      const grossProfit = recognizedRevenueCny - effectiveCost;
      const { user_finance_summary, ...userRow } = row;
      return {
        ...userRow,
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
    return {
      ...resultPage,
      summary: {
        userCount: number(rawSummary.userCount),
        excludedUserCount: number(rawSummary.excludedUserCount),
        remainingBalanceCny: number(rawSummary.remainingBalanceCny),
        positiveBalanceUserCount: number(rawSummary.positiveBalanceUserCount),
        cashPaidCny: number(rawSummary.cashPaidCny),
        cashPayingUserCount: number(rawSummary.cashPayingUserCount),
        userChargeCny,
        requests: number(rawSummary.requests),
        bookedCostCny: number(rawSummary.bookedCostCny),
        bookedProfitCny,
        partialCostUserCount: number(rawSummary.partialCostUserCount),
        grossMargin: userChargeCny ? bookedProfitCny / userChargeCny : null,
      },
    };
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

  async getAccountCostRateTimelines({ accountIds, start, end }) {
    const ids = [...new Set((accountIds || [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0))];
    const timelines = new Map(ids.map((id) => [id, { rules: [], observationsByKey: new Map() }]));
    if (!ids.length) return timelines;

    const rulesResult = await this.pool.query(`
      SELECT r.id,r.source_account_id,r.cost_mode,r.basis_mode,r.upstream_multiplier,
             r.supplier_key_id,r.effective_from,r.effective_to,r.status,
             k.rate_multiplier AS current_supplier_multiplier
      FROM ${this.schema}.account_cost_rules r
      LEFT JOIN ${this.schema}.supplier_keys k ON k.id=r.supplier_key_id
      WHERE r.source_account_id=ANY($1::bigint[])
        AND r.status IN ('active','superseded')
        AND r.effective_from<$3
        AND (r.effective_to IS NULL OR r.effective_to>$2)
      ORDER BY r.source_account_id,r.effective_from,r.id`, [ids, start, end]);

    const supplierKeyIds = new Set();
    for (const row of rulesResult.rows) {
      const accountId = Number(row.source_account_id);
      const timeline = timelines.get(accountId);
      if (!timeline) continue;
      const supplierKeyId = row.supplier_key_id ? Number(row.supplier_key_id) : null;
      if (supplierKeyId) supplierKeyIds.add(supplierKeyId);
      timeline.rules.push({
        id: Number(row.id),
        costMode: row.cost_mode || '',
        basisMode: row.basis_mode || 'revenue_backsolve',
        upstreamMultiplier: nullableNumber(row.upstream_multiplier),
        supplierKeyId,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to || null,
        currentSupplierMultiplier: nullableNumber(row.current_supplier_multiplier),
      });
    }

    if (!supplierKeyIds.size) return timelines;
    const observationsResult = await this.pool.query(`
      SELECT supplier_key_id,rate_multiplier,observed_at,change_type
      FROM ${this.schema}.supplier_key_observations
      WHERE supplier_key_id=ANY($1::bigint[])
        AND observed_at<$2
        AND change_type NOT IN ('snapshot','quota_changed')
        AND rate_multiplier IS NOT NULL
      ORDER BY supplier_key_id,observed_at,id`, [[...supplierKeyIds], end]);
    const observationsByKey = new Map();
    for (const row of observationsResult.rows) {
      const keyId = Number(row.supplier_key_id);
      if (!observationsByKey.has(keyId)) observationsByKey.set(keyId, []);
      observationsByKey.get(keyId).push({
        rateMultiplier: nullableNumber(row.rate_multiplier),
        observedAt: row.observed_at,
        changeType: row.change_type || '',
      });
    }
    for (const timeline of timelines.values()) {
      for (const rule of timeline.rules) {
        if (rule.supplierKeyId && observationsByKey.has(rule.supplierKeyId)) {
          timeline.observationsByKey.set(
            rule.supplierKeyId,
            observationsByKey.get(rule.supplierKeyId),
          );
        }
      }
    }
    return timelines;
  }

  async getAccountCostingProfiles({
    accountIds,
    start = '1970-01-01T00:00:00.000Z',
    end = '9999-12-31T23:59:59.999Z',
  }) {
    const ids = [...new Set((accountIds || [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0))];
    if (!ids.length) return [];
    const result = await this.pool.query(`
      WITH cost_ledger AS (
        SELECT p.source_account_id,
               COALESCE(SUM(
                 COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)
               ) FILTER (WHERE p.effective_from >= $2 AND p.effective_from < $3),0)
                 AS acquisition_cost_cny,
               COUNT(*)::int AS cost_record_count
        FROM ${this.schema}.account_cost_periods p
        WHERE p.status='active' AND p.source_account_id=ANY($1::bigint[])
        GROUP BY p.source_account_id
      )
      SELECT a.source_account_id AS id,
             COALESCE(rule.cost_mode,cp.cost_mode,
               CASE
                 WHEN cp.cost_type='free' THEN 'free'
                 WHEN COALESCE(ledger.cost_record_count,0)>0 THEN 'fixed_purchase'
                 WHEN linked_key.status='active' AND linked_key.rate_multiplier IS NOT NULL
                   THEN 'probe_multiplier'
                 ELSE 'unconfigured'
               END
             ) AS cost_type,
             COALESCE(rule.upstream_multiplier,
               CASE WHEN linked_key.status='active' THEN linked_key.rate_multiplier END
             ) AS upstream_multiplier,
             COALESCE(ledger.acquisition_cost_cny,0) AS acquisition_cost_cny,
             COALESCE(ledger.cost_record_count,0) AS cost_record_count,
             linked_key.rate_multiplier AS supplier_key_inventory_multiplier
      FROM ${this.schema}.dim_accounts a
      LEFT JOIN cost_ledger ledger ON ledger.source_account_id=a.source_account_id
      LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
      LEFT JOIN LATERAL (
        SELECT r.*
        FROM ${this.schema}.account_cost_rules r
        WHERE r.source_account_id=a.source_account_id
          AND r.status='active'
          AND (r.effective_to IS NULL OR r.effective_to>NOW())
        ORDER BY r.effective_from DESC,r.id DESC
        LIMIT 1
      ) rule ON TRUE
      LEFT JOIN ${this.schema}.supplier_account_links supplier_link
        ON supplier_link.source_account_id=a.source_account_id
      LEFT JOIN ${this.schema}.supplier_keys linked_key
        ON linked_key.id=supplier_link.supplier_key_id
        AND linked_key.removed_at IS NULL
      WHERE a.source_account_id=ANY($1::bigint[])
    `, [ids, start, end]);
    return result.rows.map((row) => ({
      id: number(row.id),
      costMode: row.cost_type || 'unconfigured',
      costType: row.cost_type || 'unconfigured',
      upstreamMultiplier: nullableNumber(row.upstream_multiplier),
      supplierKeyInventoryMultiplier: nullableNumber(row.supplier_key_inventory_multiplier),
      fixedAcquisitionCostCny: number(row.acquisition_cost_cny),
      hasCostRecord: number(row.cost_record_count) > 0,
    }));
  }

  async listAccounts({
    start, end, dailyStart = start, dailyEnd = end,
    search = '', scope = 'current', page = 1, pageSize = 20, offset = 0,
    platform = '', accountType = '', supplier = '', status = '', privacyMode = '',
    accountIds = null, costMode = '',
    sortBy = 'createdAt', sortOrder = 'desc',
  }) {
    const scopePredicate = {
      current: "a.source_deleted_at IS NULL",
      deleted: 'a.source_deleted_at IS NOT NULL',
      all: 'TRUE',
    }[scope] || "a.source_deleted_at IS NULL";
    const orderColumn = {
      createdAt: 'acquired_at',
      name: 'name',
      acquisitionCostCny: 'account_cost_cny',
      userChargeCny: 'user_charge_cny',
      profitCny: 'profit_cny',
      requests: 'requests',
      tokens: 'tokens',
      expiresAt: 'expires_at',
      status: 'status',
    }[sortBy] || 'acquired_at';
    const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const result = await this.pool.query(`
      WITH cost_ledger AS (
        SELECT p.source_account_id,
               SUM(COALESCE(
                 p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount
               )) FILTER (
                 WHERE p.effective_from >= $1 AND p.effective_from < $2
               ) AS acquisition_cost_cny,
               MIN(p.effective_from) AS first_acquired_at,
               MAX(p.effective_to) AS latest_coverage_end,
               COUNT(*)::int AS cost_record_count
        FROM ${this.schema}.account_cost_periods p
        WHERE p.status='active'
        GROUP BY p.source_account_id
      ), latest_period AS (
        SELECT DISTINCT ON (p.source_account_id)
               p.source_account_id,p.id,p.cost_profile_id,p.supplier,p.purchase_batch,
               p.original_amount,p.fee_amount,p.tax_amount,
               COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount) AS total_cost_cny,
               p.effective_from,p.effective_to,p.notes
        FROM ${this.schema}.account_cost_periods p
        WHERE p.status='active'
        ORDER BY p.source_account_id,p.effective_from DESC,p.id DESC
      ), oauth_item AS (
        SELECT DISTINCT ON (i.sub2api_account_id)
               i.sub2api_account_id,i.id AS order_item_id,i.external_item_id,
               i.external_account_key,i.account_name AS supplier_account_name,
               i.verification_status,i.health_status,i.quota_used_percent,i.quota_window,
               i.last_health_at,i.repair_completion_source,i.metadata,i.created_at AS item_created_at,
               i.final_cost_cny,o.id AS finops_order_id,o.external_order_id,o.product,
               o.status AS order_status,o.created_at AS order_created_at
        FROM ${this.schema}.oauth_supply_order_items i
        JOIN ${this.schema}.oauth_supply_orders o ON o.id=i.order_id
        WHERE i.sub2api_account_id IS NOT NULL
        ORDER BY i.sub2api_account_id,i.updated_at DESC,i.id DESC
      ), base_accounts AS MATERIALIZED (
        SELECT a.source_account_id AS id,a.name,a.platform,a.account_type,
               a.status AS source_status,
               CASE
                 WHEN a.status='active' AND a.temp_unschedulable_until>NOW()
                   THEN 'temp_unschedulable'
                 WHEN a.status='active' AND a.rate_limit_reset_at>NOW()
                   THEN 'rate_limited'
                 WHEN a.status='active' AND NOT a.schedulable
                   THEN 'unschedulable'
                 ELSE a.status
               END AS status,
               a.privacy_mode,
               COALESCE(
                 a.expires_at,
                 CASE
                   WHEN oauth.metadata->>'remainingSeconds' ~ '^[0-9]+(\\.[0-9]+)?$'
                     THEN oauth.order_created_at
                       + make_interval(secs => FLOOR((oauth.metadata->>'remainingSeconds')::numeric)::integer)
                   ELSE ledger.latest_coverage_end
                 END
               ) AS expires_at,
               a.source_deleted_at,a.tags,a.cost_profile_id,
               COALESCE(ledger.first_acquired_at,oauth.item_created_at,a.source_updated_at) AS acquired_at,
               COALESCE(ledger.acquisition_cost_cny,0) AS acquisition_cost_cny,
               COALESCE(ledger.cost_record_count,0) AS cost_record_count,
               COALESCE(NULLIF(period.supplier,''),CASE WHEN oauth.order_item_id IS NOT NULL THEN 'OAuth Supply' END,
                 NULLIF(a.supplier,''),linked_supplier.name,'') AS resolved_supplier,
               COALESCE(NULLIF(period.purchase_batch,''),
                 CASE WHEN oauth.external_order_id IS NOT NULL THEN 'oauth-supply:'||oauth.external_order_id END,
                 NULLIF(a.purchase_batch,''),'') AS resolved_purchase_batch,
               COALESCE(rule.cost_mode,cp.cost_mode,
                 CASE
                   WHEN cp.cost_type='free' THEN 'free'
                   WHEN COALESCE(ledger.cost_record_count,0)>0 THEN 'fixed_purchase'
                   WHEN linked_key.status='active' AND linked_key.rate_multiplier IS NOT NULL THEN 'probe_multiplier'
                   ELSE 'unconfigured'
                 END
               ) AS cost_type,
               COALESCE(rule.basis_mode,cp.basis_mode,'revenue_backsolve') AS basis_mode,
               COALESCE(rule.upstream_multiplier,
                 CASE WHEN linked_key.status='active' THEN linked_key.rate_multiplier END
               ) AS upstream_multiplier,
               COALESCE(rule.cny_per_reference_unit,cp.cny_per_reference_unit) AS cny_per_reference_unit,
               supplier_link.supplier_key_id,supplier_link.created_at AS supplier_key_linked_at,
               linked_key.name AS supplier_key_name,linked_key.masked_key AS supplier_key_masked,
               linked_key.group_name AS supplier_key_group_name,
               linked_key.rate_multiplier AS supplier_key_inventory_multiplier,
               linked_key.last_check_status AS supplier_key_check_status,
               linked_key.last_check_at AS supplier_key_check_at,
               linked_connection.id AS supplier_connection_id,
               linked_connection.name AS supplier_connection_name,
               linked_supplier.name AS linked_supplier_name,
               period.id AS current_cost_period_id,
               period.cost_profile_id AS current_cost_profile_id,
               period.supplier AS current_cost_supplier,
               period.purchase_batch AS current_cost_purchase_batch,
               period.total_cost_cny AS current_total_cost_cny,
               period.original_amount AS current_original_amount,
               period.fee_amount AS current_fee_amount,period.tax_amount AS current_tax_amount,
               period.effective_from AS current_effective_from,
               period.effective_to AS current_effective_to,period.notes AS current_cost_notes,
               oauth.order_item_id,oauth.external_item_id,oauth.external_account_key,
               oauth.verification_status,oauth.health_status,oauth.quota_used_percent,
               oauth.quota_window,oauth.last_health_at,oauth.repair_completion_source,
               oauth.finops_order_id,oauth.external_order_id,oauth.product,oauth.order_status,
               oauth.order_created_at,
               CASE WHEN oauth.metadata->>'originalPriceCny' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (oauth.metadata->>'originalPriceCny')::numeric END AS original_price_cny,
               CASE WHEN oauth.metadata->>'supplierChargedCny' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (oauth.metadata->>'supplierChargedCny')::numeric END AS supplier_charged_cny
        FROM ${this.schema}.dim_accounts a
        LEFT JOIN cost_ledger ledger ON ledger.source_account_id=a.source_account_id
        LEFT JOIN latest_period period ON period.source_account_id=a.source_account_id
        LEFT JOIN oauth_item oauth ON oauth.sub2api_account_id=a.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=a.cost_profile_id
        LEFT JOIN LATERAL (
          SELECT r.*
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=a.source_account_id AND r.status='active'
            AND (r.effective_to IS NULL OR r.effective_to>NOW())
          ORDER BY r.effective_from DESC,r.id DESC LIMIT 1
        ) rule ON TRUE
        LEFT JOIN ${this.schema}.supplier_account_links supplier_link
          ON supplier_link.source_account_id=a.source_account_id
        LEFT JOIN ${this.schema}.supplier_keys linked_key
          ON linked_key.id=supplier_link.supplier_key_id AND linked_key.removed_at IS NULL
        LEFT JOIN ${this.schema}.supplier_connections linked_connection
          ON linked_connection.id=linked_key.connection_id
        LEFT JOIN ${this.schema}.suppliers linked_supplier
          ON linked_supplier.id=linked_connection.supplier_id
        WHERE ${scopePredicate}
      ), filtered_accounts AS MATERIALIZED (
        SELECT *
        FROM base_accounts
        WHERE ($3='' OR name ILIKE '%'||$3||'%' OR id::text=$3
            OR external_account_key ILIKE '%'||$3||'%'
            OR external_order_id ILIKE '%'||$3||'%'
            OR resolved_purchase_batch ILIKE '%'||$3||'%')
          AND ($4='' OR platform=$4)
          AND ($5='' OR resolved_supplier=$5)
          AND ($6='' OR status=$6)
          AND ($7='' OR cost_type=$7)
          AND ($8='' OR account_type=$8)
          AND (
            $9='' OR
            ($9='__unset__' AND COALESCE(privacy_mode,'')='') OR
            privacy_mode=$9
          )
          AND (
            $10::bigint[] IS NULL OR id=ANY($10::bigint[])
          )
      ), usage AS MATERIALIZED (
        SELECT d.source_account_id,
               SUM(d.user_charge_cny) AS user_charge_cny,
               SUM(d.standard_cost_usd_reference) AS token_list_value_usd,
               SUM(d.requests)::float8 AS requests,
               SUM(d.input_tokens+d.output_tokens+d.cache_creation_tokens+d.cache_read_tokens)::float8 AS tokens
        FROM ${this.schema}.fact_usage_daily d
        JOIN filtered_accounts account ON account.id=d.source_account_id
        WHERE d.day >= $11::date AND d.day <= $12::date
        GROUP BY d.source_account_id
      ), multiplier_costs AS MATERIALIZED (
        SELECT facts.source_account_id,
               COALESCE(SUM(facts.calculated_cost_cny)
                 FILTER (WHERE facts.cost_status='priced'),0) AS multiplier_cost_cny,
               COALESCE(SUM(facts.user_charge_cny)
                 FILTER (WHERE facts.cost_status NOT IN ('priced','free','fixed_cost')),0)
                 AS unpriced_user_charge_cny,
               COUNT(*) FILTER (WHERE facts.cost_status='priced')::int AS priced_usage_count,
               COUNT(*) FILTER (
                 WHERE facts.cost_status NOT IN ('priced','free','fixed_cost')
               )::int AS unpriced_usage_count,
               MAX(facts.cost_mode) FILTER (WHERE facts.cost_status='priced') AS priced_cost_mode,
               MIN(facts.upstream_multiplier) FILTER (WHERE facts.cost_status='priced')
                 AS period_upstream_multiplier_min,
               MAX(facts.upstream_multiplier) FILTER (WHERE facts.cost_status='priced')
                 AS period_upstream_multiplier_max,
               MIN(facts.selling_multiplier) FILTER (WHERE facts.cost_status='priced')
                 AS period_selling_multiplier_min,
               MAX(facts.selling_multiplier) FILTER (WHERE facts.cost_status='priced')
                 AS period_selling_multiplier_max,
               MAX(facts.upstream_multiplier_source)
                 FILTER (WHERE facts.cost_status='priced') AS multiplier_cost_source
        FROM ${this.schema}.usage_cost_facts facts
        JOIN filtered_accounts account ON account.id=facts.source_account_id
        WHERE facts.occurred_at >= $1 AND facts.occurred_at < $2
        GROUP BY facts.source_account_id
      ), account_costs AS (
        SELECT account.*,
               COALESCE(usage.user_charge_cny,0) AS user_charge_cny,
               COALESCE(usage.token_list_value_usd,0) AS token_list_value_usd,
               COALESCE(usage.requests,0)::float8 AS requests,
               COALESCE(usage.tokens,0)::float8 AS tokens,
               COALESCE(multiplier.multiplier_cost_cny,0) AS multiplier_cost_cny,
               COALESCE(multiplier.unpriced_user_charge_cny,0) AS unpriced_user_charge_cny,
               COALESCE(multiplier.priced_usage_count,0) AS priced_usage_count,
               COALESCE(multiplier.unpriced_usage_count,0) AS unpriced_usage_count,
               multiplier.priced_cost_mode,
               multiplier.period_upstream_multiplier_min,
               multiplier.period_upstream_multiplier_max,
               multiplier.period_selling_multiplier_min,
               multiplier.period_selling_multiplier_max,
               COALESCE(multiplier.multiplier_cost_source,'') AS multiplier_cost_source,
               CASE
                 WHEN account.cost_type='free' THEN 0
                 WHEN account.cost_type='fixed_purchase' THEN account.acquisition_cost_cny
                 WHEN account.cost_type IN ('probe_multiplier','manual_multiplier')
                   OR COALESCE(multiplier.priced_usage_count,0)>0
                   THEN COALESCE(multiplier.multiplier_cost_cny,0)
                 ELSE 0
               END AS account_cost_cny,
               CASE
                 WHEN account.cost_type NOT IN ('fixed_purchase','free')
                   AND COALESCE(multiplier.priced_usage_count,0)>0
                   THEN COALESCE(multiplier.priced_cost_mode,account.cost_type)
                 ELSE account.cost_type
               END AS effective_cost_type,
               CASE
                 WHEN account.cost_type='free' THEN 'complete'
                 WHEN account.cost_type='fixed_purchase' AND account.cost_record_count>0 THEN 'complete'
                 WHEN account.cost_type='fixed_purchase' THEN 'missing'
                 WHEN account.cost_type IN ('probe_multiplier','manual_multiplier')
                   OR COALESCE(multiplier.priced_usage_count,0)>0
                   THEN CASE
                     WHEN COALESCE(multiplier.unpriced_user_charge_cny,0)>0
                       AND COALESCE(multiplier.priced_usage_count,0)>0 THEN 'partial'
                     WHEN COALESCE(multiplier.unpriced_user_charge_cny,0)>0 THEN 'missing'
                     WHEN COALESCE(multiplier.priced_usage_count,0)>0 THEN 'complete'
                     WHEN account.upstream_multiplier>0 THEN 'configured'
                     ELSE 'missing'
                   END
                 WHEN COALESCE(usage.requests,0)>0 THEN 'missing'
                 ELSE 'pending'
               END AS cost_coverage_status
        FROM filtered_accounts account
        LEFT JOIN usage ON usage.source_account_id=account.id
        LEFT JOIN multiplier_costs multiplier ON multiplier.source_account_id=account.id
      ), economics AS (
        SELECT account_costs.*,
               user_charge_cny-account_cost_cny AS profit_cny
        FROM account_costs
      )
      SELECT economics.*,
             COUNT(*) OVER() AS total_count,
             COALESCE(SUM(account_cost_cny) OVER(),0) AS summary_cost_cny,
             COALESCE(SUM(acquisition_cost_cny)
               FILTER (WHERE cost_type='fixed_purchase') OVER(),0) AS summary_fixed_cost_cny,
             COALESCE(SUM(multiplier_cost_cny) OVER(),0) AS summary_multiplier_cost_cny,
             COALESCE(SUM(user_charge_cny) OVER(),0) AS summary_user_charge_cny,
             COALESCE(SUM(profit_cny) OVER(),0) AS summary_profit_cny,
             COALESCE(SUM(requests) OVER(),0) AS summary_requests,
             COUNT(*) FILTER (WHERE cost_coverage_status IN ('missing','partial')) OVER()
               AS summary_missing_cost_count
      FROM economics
      ORDER BY ${orderColumn} ${orderDirection} NULLS LAST,id DESC
      LIMIT $13 OFFSET $14`,
    [
      start, end, search, platform, supplier, status, costMode, accountType, privacyMode, accountIds,
      dailyStart, dailyEnd, pageSize, offset,
    ]);
    const first = result.rows[0];
    const items = result.rows.map((row) => {
      const fixedAcquisitionCostCny = number(row.acquisition_cost_cny);
      const multiplierCostCny = number(row.multiplier_cost_cny);
      const accountCostCny = number(row.account_cost_cny);
      const userChargeCny = number(row.user_charge_cny);
      const profitCny = number(row.profit_cny);
      const hasCostRecord = number(row.cost_record_count) > 0;
      return {
        id: number(row.id),
        name: row.name,
        platform: row.platform,
        accountType: row.account_type || '',
        status: row.status,
        sourceStatus: row.source_status || '',
        privacyMode: row.privacy_mode || '',
        expiresAt: row.expires_at || null,
        createdAt: row.acquired_at || null,
        acquiredAt: row.acquired_at || null,
        sourceDeletedAt: row.source_deleted_at || null,
        tags: row.tags || [],
        costMode: row.cost_type,
        costType: row.cost_type,
        costProfileId: row.cost_profile_id ? number(row.cost_profile_id) : null,
        supplier: row.resolved_supplier || '',
        purchaseBatch: row.resolved_purchase_batch || '',
        acquisitionCostCny: accountCostCny,
        accountCostCny,
        fixedAcquisitionCostCny,
        multiplierCostCny,
        periodCost: accountCostCny,
        periodCostCny: accountCostCny,
        purchaseAllocatedCostCny: fixedAcquisitionCostCny,
        effectiveCostCny: accountCostCny,
        fullyLoadedCost: accountCostCny,
        fullyLoadedCostCny: accountCostCny,
        bookedCostCny: accountCostCny,
        userChargeCny,
        revenue: userChargeCny,
        revenueCny: userChargeCny,
        recognizedRevenueCny: userChargeCny,
        profitCny,
        grossProfit: profitCny,
        grossProfitCny: profitCny,
        bookedProfitCny: profitCny,
        grossMargin: userChargeCny ? profitCny / userChargeCny : null,
        tokenListValueUsd: number(row.token_list_value_usd),
        requests: number(row.requests),
        tokens: number(row.tokens),
        costCoverageStatus: row.cost_coverage_status || 'pending',
        hasCostRecord: row.cost_type === 'free'
          || hasCostRecord
          || number(row.priced_usage_count) > 0
          || (
            ['probe_multiplier', 'manual_multiplier'].includes(row.cost_type)
            && number(row.upstream_multiplier) > 0
          ),
        costConfigurationConflict: false,
        lifecycle: row.source_deleted_at ? 'deleted' : row.status === 'active' ? 'current' : 'inactive',
        effectiveCostMode: row.effective_cost_type || row.cost_type,
        basisMode: row.basis_mode || 'revenue_backsolve',
        upstreamMultiplier: nullableNumber(row.upstream_multiplier),
        cnyPerReferenceUnit: nullableNumber(row.cny_per_reference_unit),
        unpricedUserChargeCny: number(row.unpriced_user_charge_cny),
        pricedUsageCount: number(row.priced_usage_count),
        unpricedUsageCount: number(row.unpriced_usage_count),
        periodUpstreamMultiplierMin: nullableNumber(row.period_upstream_multiplier_min),
        periodUpstreamMultiplierMax: nullableNumber(row.period_upstream_multiplier_max),
        periodSellingMultiplierMin: nullableNumber(row.period_selling_multiplier_min),
        periodSellingMultiplierMax: nullableNumber(row.period_selling_multiplier_max),
        multiplierCostSource: row.multiplier_cost_source || '',
        supplierKeyId: row.supplier_key_id ? number(row.supplier_key_id) : null,
        supplierKeyLinkedAt: row.supplier_key_linked_at || null,
        supplierKeyName: row.supplier_key_name || '',
        supplierKeyMasked: row.supplier_key_masked || '',
        supplierKeyGroupName: row.supplier_key_group_name || '',
        supplierKeyInventoryMultiplier: nullableNumber(row.supplier_key_inventory_multiplier),
        supplierKeyCheckStatus: row.supplier_key_check_status || '',
        supplierKeyCheckAt: row.supplier_key_check_at || null,
        supplierConnectionId: row.supplier_connection_id ? number(row.supplier_connection_id) : null,
        supplierConnectionName: row.supplier_connection_name || '',
        linkedSupplierName: row.linked_supplier_name || '',
        currentCostPeriodId: row.current_cost_period_id ? number(row.current_cost_period_id) : null,
        currentCostProfileId: row.current_cost_profile_id ? number(row.current_cost_profile_id) : null,
        currentCostSupplier: row.current_cost_supplier || '',
        currentCostPurchaseBatch: row.current_cost_purchase_batch || '',
        currentTotalCostCny: number(row.current_total_cost_cny),
        currentOriginalAmount: number(row.current_original_amount),
        currentFeeAmount: number(row.current_fee_amount),
        currentTaxAmount: number(row.current_tax_amount),
        currentEffectiveFrom: row.current_effective_from || null,
        currentEffectiveTo: row.current_effective_to || null,
        currentCostNotes: row.current_cost_notes || '',
        orderItemId: row.order_item_id ? number(row.order_item_id) : null,
        externalItemId: row.external_item_id || '',
        externalAccountKey: row.external_account_key || '',
        finopsOrderId: row.finops_order_id ? number(row.finops_order_id) : null,
        externalOrderId: row.external_order_id || '',
        product: row.product || '',
        orderStatus: row.order_status || '',
        verificationStatus: row.verification_status || '',
        healthStatus: row.health_status || '',
        quotaUsedPercent: nullableNumber(row.quota_used_percent),
        quotaWindow: row.quota_window || '',
        lastHealthAt: row.last_health_at || null,
        repairCompletionSource: row.repair_completion_source || '',
        originalPriceCny: nullableNumber(row.original_price_cny),
        supplierChargedCny: nullableNumber(row.supplier_charged_cny),
        releasedCostCny: row.original_price_cny === null
          ? null : Math.max(0, number(row.original_price_cny) - fixedAcquisitionCostCny),
      };
    });
    return {
      items,
      total: first ? number(first.total_count) : 0,
      page,
      pageSize,
      summary: {
        accountCount: first ? number(first.total_count) : 0,
        acquisitionCostCny: first ? number(first.summary_cost_cny) : 0,
        accountCostCny: first ? number(first.summary_cost_cny) : 0,
        fixedAcquisitionCostCny: first ? number(first.summary_fixed_cost_cny) : 0,
        multiplierCostCny: first ? number(first.summary_multiplier_cost_cny) : 0,
        userChargeCny: first ? number(first.summary_user_charge_cny) : 0,
        profitCny: first ? number(first.summary_profit_cny) : 0,
        requests: first ? number(first.summary_requests) : 0,
        missingCostCount: first ? number(first.summary_missing_cost_count) : 0,
      },
    };
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
              p.original_amount,p.fee_amount,p.tax_amount,
              COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount) AS total_cost_cny,
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
          SELECT p.source_account_id,COALESCE(SUM(COALESCE(
            p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount
          )) FILTER (WHERE p.effective_from >= $3 AND p.effective_from < $4),0)::float8
            AS purchase_allocated_cost_cny,
            COUNT(*) AS cost_record_count
          FROM ${this.schema}.account_cost_periods p
          WHERE p.status='active'
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
               COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount)::float8 AS total_cost,
               p.effective_from,p.effective_to,p.status
        FROM ${this.schema}.account_cost_periods p
        JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles cp ON cp.id=p.cost_profile_id
        WHERE p.status='active' AND p.effective_from >= $1 AND p.effective_from < $2
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
    const [suppliers, filterSuppliers, batches, supplierKeys, accountFilters, groups] = await Promise.all([
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
        SELECT DISTINCT ON (LOWER(name)) name
        FROM (
          SELECT s.name
          FROM ${this.schema}.suppliers s
          WHERE s.status='active'
            AND EXISTS (
              SELECT 1
              FROM ${this.schema}.supplier_connections c
              WHERE c.supplier_id=s.id
            )
          UNION ALL
          SELECT 'OAuth Supply'
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
      this.pool.query(`
        SELECT k.id,k.external_key_id,k.name,k.masked_key,k.group_name,k.rate_multiplier,k.last_check_status,
               k.last_check_at,c.id AS connection_id,c.name AS connection_name,s.name AS supplier_name,
               COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type) AS adapter_type,
               l.source_account_id
        FROM ${this.schema}.supplier_keys k
        JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
        WHERE k.removed_at IS NULL AND k.status='active' AND c.enabled
          AND COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type) IN ('sub2api','newapi')
        ORDER BY s.name,c.name,k.name,k.id`),
      this.pool.query(`
        SELECT
          COALESCE(ARRAY_AGG(DISTINCT platform ORDER BY platform)
            FILTER (WHERE platform<>''),'{}') AS platforms,
          COALESCE(ARRAY_AGG(DISTINCT account_type ORDER BY account_type)
            FILTER (WHERE account_type<>''),'{}') AS account_types
        FROM ${this.schema}.dim_accounts
        WHERE source_deleted_at IS NULL`),
      this.pool.query(`
        SELECT source_group_id AS id,name,platform
        FROM ${this.schema}.source_group_catalog
        WHERE status='active'
        ORDER BY sort_order,source_group_id`),
    ]);
    const keyCatalog = supplierKeys.rows.map((row) => ({
      id:Number(row.id),
      externalId:row.external_key_id,
      supplier:row.supplier_name,
      connectionId:Number(row.connection_id),
      connectionName:row.connection_name,
      adapterType:row.adapter_type,
      name:row.name,
      maskedKey:row.masked_key,
      groupName:row.group_name,
      purchaseBatch:supplierKeyPurchaseBatch(row),
      rateMultiplier:nullableNumber(row.rate_multiplier),
      checkStatus:row.last_check_status,
      checkedAt:row.last_check_at,
      accountId:row.source_account_id ? Number(row.source_account_id) : null,
    }));
    const batchCatalog = [
      ...batches.rows.map((row) => ({ supplier: row.supplier, purchaseBatch: row.purchase_batch })),
      ...keyCatalog.map((row) => ({
        supplier: row.supplier,
        purchaseBatch: row.purchaseBatch,
        supplierKeyId: row.id,
        source: `${row.adapterType}_key`,
      })),
    ];
    const uniqueBatches = new Map();
    for (const item of batchCatalog) {
      const key = `${String(item.supplier || '').toLowerCase()}\u0000${String(item.purchaseBatch || '')}`;
      if (!uniqueBatches.has(key)) uniqueBatches.set(key, item);
    }
    return {
      suppliers: suppliers.rows.map((row) => row.name),
      filterSuppliers: filterSuppliers.rows.map((row) => row.name),
      platforms: accountFilters.rows[0]?.platforms || [],
      accountTypes: accountFilters.rows[0]?.account_types || [],
      groups: groups.rows.map((row) => ({
        id: Number(row.id),
        name: row.name || '',
        platform: row.platform || '',
      })),
      batches: [...uniqueBatches.values()],
      supplierKeys: keyCatalog,
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
    const multiplierMode = ['manual_multiplier', 'probe_multiplier'].includes(costMode);
    const basisMode = input.basisMode || profile?.basis_mode || 'revenue_backsolve';
    const changeStrategy = input.changeStrategy || 'future_only';
    const customEffectiveFrom = changeStrategy === 'custom_time' ? input.effectiveFrom : null;
    if (changeStrategy === 'custom_time' && !customEffectiveFrom) {
      throw httpError('custom_time requires effectiveFrom', 400);
    }
    if (changeStrategy === 'custom_time' && !multiplierMode) {
      throw httpError('custom_time is supported only for multiplier cost rules', 400);
    }
    const strictFutureOnly = Boolean(input.strictFutureOnly);
    const supplierKeyId = input.supplierKeyId ?? null;
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
      && String(currentRule.supplier_key_id ?? '') === String(supplierKeyId ?? '')
      && String(currentRule.notes || '') === String(input.notes || '');
    const replacesExistingTimeline = multiplierMode
      && (changeStrategy === 'current_day' || changeStrategy === 'custom_time');
    if (sameCurrentRule && !replacesExistingTimeline) return { ...currentRule, unchanged: true };

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
    } else if (changeStrategy === 'custom_time' && multiplierMode) {
      const archive = await client.query(`
        SELECT cutoff_at
        FROM ${this.schema}.account_cost_archives
        WHERE source_account_id=$1 AND cutoff_at>$2
        ORDER BY cutoff_at DESC,id DESC LIMIT 1
        FOR UPDATE`, [accountId, customEffectiveFrom]);
      if (archive.rowCount) {
        throw httpError('the custom start time overlaps archived pricing; create an audited historical correction', 409);
      }
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET status='void',effective_to=NULL,updated_at=$3
        WHERE source_account_id=$1
          AND status IN ('active','superseded')
          AND effective_from >= $2`, [accountId, customEffectiveFrom, clock.now_at]);
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_to=$2,status='superseded',updated_at=$3
        WHERE source_account_id=$1
          AND status IN ('active','superseded')
          AND effective_from < $2
          AND (effective_to IS NULL OR effective_to>$2)`, [accountId, customEffectiveFrom, clock.now_at]);
    } else if (!strictFutureOnly && !clock.has_multiplier_before_today && clock.first_today_multiplier_rule_id) {
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_from=$2,updated_at=$3
        WHERE id=$1 AND effective_from>$2`, [
        clock.first_today_multiplier_rule_id, clock.day_start, clock.now_at,
      ]);
    }
    const firstMultiplierToday = Boolean(clock.first_today_multiplier_rule_id);
    const effectiveFrom = strictFutureOnly
      ? clock.now_at
      : changeStrategy === 'current_day' && multiplierMode
      ? clock.day_start
      : changeStrategy === 'custom_time' && multiplierMode
      ? customEffectiveFrom
      : multiplierMode
      && !clock.has_multiplier_before_today
      && !firstMultiplierToday
      ? clock.day_start
      : clock.now_at;
    if (!replacesExistingTimeline) {
      await client.query(`
        UPDATE ${this.schema}.account_cost_rules
        SET effective_to=$2,status='superseded',updated_at=$2
        WHERE source_account_id=$1 AND status='active' AND effective_to IS NULL`,
      [accountId, clock.now_at]);
    }
    const result = await client.query(`
      INSERT INTO ${this.schema}.account_cost_rules(
        source_account_id,cost_profile_id,cost_mode,basis_mode,upstream_multiplier,
        selling_multiplier,cny_per_reference_unit,effective_from,status,notes,created_by,change_strategy,
        supplier_key_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12) RETURNING *`,
    [
      accountId,costProfileId,costMode,basisMode,
      upstreamMultiplier,sourceSellingMultiplier,cnyPerReferenceUnit,effectiveFrom,input.notes || '',actor,changeStrategy,
      supplierKeyId,
    ]);
    await client.query(`
      INSERT INTO ${this.schema}.usage_cost_reprice_queue(source_usage_id,reason,queued_at)
      SELECT snapshot.source_usage_id,'cost_rule_changed',NOW()
      FROM ${this.schema}.fact_usage_cost_snapshots snapshot
      WHERE snapshot.source_account_id=$1
        AND (
          snapshot.finalized=FALSE
          OR snapshot.cost_status NOT IN ('priced','free','fixed_cost')
        )
        AND snapshot.occurred_at >= $2
      ON CONFLICT(source_usage_id) DO UPDATE SET
        reason=EXCLUDED.reason,queued_at=EXCLUDED.queued_at`, [accountId,effectiveFrom]);
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
      let supplierKeyId = null;
      let linkedSupplier = null;
      let linkedPurchaseBatch = null;
      if (selectedMode === 'probe_multiplier') {
        const linkedKey = await client.query(`
          SELECT k.id,k.external_key_id,k.name,k.masked_key,k.group_name,s.name AS supplier_name
          FROM ${this.schema}.supplier_account_links l
          JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
          JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
          JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
          WHERE l.source_account_id=$1
            AND ($2::bigint IS NULL OR k.id=$2)
            AND k.removed_at IS NULL AND k.status='active' AND c.enabled
            AND COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type) IN ('sub2api','newapi')
          LIMIT 1`, [accountId,input.supplierKeyId]);
        if (input.supplierKeyId && !linkedKey.rowCount) {
          throw httpError('link the selected Sub2API or NewAPI supplier key to this account before saving automatic multiplier costs', 409);
        }
        if (linkedKey.rowCount) {
          supplierKeyId = Number(linkedKey.rows[0].id);
          linkedSupplier = linkedKey.rows[0].supplier_name;
          linkedPurchaseBatch = supplierKeyPurchaseBatch(linkedKey.rows[0]);
        }
      }
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
        rule = await this.upsertAccountCostRule(client, accountId, { ...input, supplierKeyId }, profile, actor);
      }
      const result = await client.query(`UPDATE ${this.schema}.dim_accounts
        SET cost_profile_id=$2,supplier=$3,purchase_batch=$4,tags=$5::jsonb,synced_at=NOW()
        WHERE source_account_id=$1 RETURNING *`,
      [
        accountId,
        input.costProfileId,
        selectedMode === 'probe_multiplier' ? linkedSupplier || '' : input.supplier,
        selectedMode === 'probe_multiplier' ? linkedPurchaseBatch || '' : input.purchaseBatch,
        JSON.stringify(input.tags),
      ]);
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
      SELECT c.*,s.name AS supplier_name,s.notes AS supplier_notes,b.balance,
             COALESCE(keys.key_count,0)::int AS key_count,
             COALESCE(keys.active_key_count,0)::int AS active_key_count,
             COALESCE(keys.failed_key_count,0)::int AS failed_key_count,
             COALESCE(alerts.open_alert_count,0)::int AS open_alert_count,
             COALESCE(guard_accounts.linked_account_count,0)::int AS linked_account_count,
             COALESCE(guard_accounts.configured_account_count,0)::int AS profit_guard_configured_account_count,
             COALESCE(guard_accounts.enabled_account_count,0)::int AS profit_guard_account_count,
             (profit_guard.connection_id IS NOT NULL
               OR COALESCE(guard_accounts.configured_account_count,0)>0) AS profit_guard_configured,
             (COALESCE(profit_guard.enabled,FALSE)
               OR COALESCE(guard_accounts.enabled_account_count,0)>0) AS profit_guard_enabled,
             (COALESCE(profit_guard.enabled,FALSE)
               OR (COALESCE(guard_accounts.linked_account_count,0)>0
                 AND guard_accounts.enabled_account_count=guard_accounts.linked_account_count)) AS profit_guard_fully_enabled
       FROM ${this.schema}.supplier_connections c
       JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
       LEFT JOIN ${this.schema}.supplier_profit_guard_defaults profit_guard
         ON profit_guard.connection_id=c.id
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT links.source_account_id)::int AS linked_account_count,
               COUNT(DISTINCT links.source_account_id) FILTER (
                 WHERE policies.source_account_id IS NOT NULL
               )::int AS configured_account_count,
               COUNT(DISTINCT links.source_account_id) FILTER (
                 WHERE policies.enabled
               )::int AS enabled_account_count
        FROM ${this.schema}.supplier_keys guard_keys
        JOIN ${this.schema}.supplier_account_links links ON links.supplier_key_id=guard_keys.id
        LEFT JOIN ${this.schema}.account_profit_guard_policies policies
          ON policies.source_account_id=links.source_account_id
        WHERE guard_keys.connection_id=c.id AND guard_keys.removed_at IS NULL
      ) guard_accounts ON TRUE
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
      SELECT c.*,s.name AS supplier_name,s.notes AS supplier_notes,b.balance,
             COALESCE(keys.key_count,0)::int AS key_count,
             COALESCE(keys.active_key_count,0)::int AS active_key_count,
             COALESCE(keys.failed_key_count,0)::int AS failed_key_count,
             COALESCE(alerts.open_alert_count,0)::int AS open_alert_count,
             COALESCE(guard_accounts.linked_account_count,0)::int AS linked_account_count,
             COALESCE(guard_accounts.configured_account_count,0)::int AS profit_guard_configured_account_count,
             COALESCE(guard_accounts.enabled_account_count,0)::int AS profit_guard_account_count,
             (profit_guard.connection_id IS NOT NULL
               OR COALESCE(guard_accounts.configured_account_count,0)>0) AS profit_guard_configured,
             (COALESCE(profit_guard.enabled,FALSE)
               OR COALESCE(guard_accounts.enabled_account_count,0)>0) AS profit_guard_enabled,
             (COALESCE(profit_guard.enabled,FALSE)
               OR (COALESCE(guard_accounts.linked_account_count,0)>0
                 AND guard_accounts.enabled_account_count=guard_accounts.linked_account_count)) AS profit_guard_fully_enabled
       FROM ${this.schema}.supplier_connections c
       JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
       LEFT JOIN ${this.schema}.supplier_profit_guard_defaults profit_guard
         ON profit_guard.connection_id=c.id
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT links.source_account_id)::int AS linked_account_count,
               COUNT(DISTINCT links.source_account_id) FILTER (
                 WHERE policies.source_account_id IS NOT NULL
               )::int AS configured_account_count,
               COUNT(DISTINCT links.source_account_id) FILTER (
                 WHERE policies.enabled
               )::int AS enabled_account_count
        FROM ${this.schema}.supplier_keys guard_keys
        JOIN ${this.schema}.supplier_account_links links ON links.supplier_key_id=guard_keys.id
        LEFT JOIN ${this.schema}.account_profit_guard_policies policies
          ON policies.source_account_id=links.source_account_id
        WHERE guard_keys.connection_id=c.id AND guard_keys.removed_at IS NULL
      ) guard_accounts ON TRUE
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
        SET website_url=$2,supplier_type=$3,notes=$4,updated_at=NOW() WHERE id=$1`,
      [supplierId, input.baseUrl, input.adapterType, input.supplierNotes || '']);
      let result;
      try {
        result = await client.query(`
          INSERT INTO ${this.schema}.supplier_connections(
            supplier_id,name,adapter_type,base_url,auth_mode,credential_label,credentials_ciphertext,
            enabled,alert_enabled,inventory_interval_seconds,inventory_interval_minutes,active_check_enabled,active_check_limit,
            quality_monitor_mode,low_balance_threshold,balance_currency,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          RETURNING *`, [
          supplierId,input.name,input.adapterType,input.baseUrl,input.authMode,input.credentialLabel,
          credentialsCiphertext,input.enabled,input.alertEnabled,input.inventoryIntervalSeconds,Math.max(5, Math.ceil(input.inventoryIntervalSeconds / 60)),input.activeCheckEnabled,
          input.activeCheckLimit,input.qualityMonitorMode,input.lowBalanceThreshold,input.balanceCurrency,actor,actor,
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
        SET website_url=$2,supplier_type=$3,notes=$4,updated_at=NOW() WHERE id=$1`,
      [supplierId,input.baseUrl,input.adapterType,input.supplierNotes || '']);
      let result;
      try {
        result = await client.query(`
          UPDATE ${this.schema}.supplier_connections SET
            supplier_id=$2,name=$3,adapter_type=$4,base_url=$5,auth_mode=$6,credential_label=$7,
            credentials_ciphertext=$8,enabled=$9,alert_enabled=$10,inventory_interval_seconds=$11,inventory_interval_minutes=$12,
            active_check_enabled=$13,active_check_limit=$14,quality_monitor_mode=$15,
            low_balance_threshold=$16,
            balance_currency=$17,connection_status=CASE WHEN $9 THEN 'pending' ELSE 'disabled' END,
            next_sync_at=CASE WHEN $9 THEN NOW() ELSE next_sync_at END,last_error='',updated_by=$18,updated_at=NOW()
          WHERE id=$1 RETURNING *`, [
          connectionId,supplierId,input.name,input.adapterType,input.baseUrl,input.authMode,input.credentialLabel,
          credentialsCiphertext,input.enabled,input.alertEnabled,input.inventoryIntervalSeconds,Math.max(5, Math.ceil(input.inventoryIntervalSeconds / 60)),input.activeCheckEnabled,
          input.activeCheckLimit,input.qualityMonitorMode,input.lowBalanceThreshold,input.balanceCurrency,actor,
        ]);
      } catch (error) {
        if (error?.code === '23505') throw httpError('该供应商下已存在同名连接', 409);
        throw error;
      }
      const row = { ...result.rows[0], supplier_name: input.supplierName };
      if (!input.alertEnabled) {
        await client.query(`UPDATE ${this.schema}.supplier_alert_events
          SET status='resolved',resolved_at=NOW(),last_seen_at=NOW()
          WHERE connection_id=$1 AND status='open'`, [connectionId]);
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_connection','supplier_connection',$2,$3::jsonb)`,
      [actor,String(connectionId),JSON.stringify({ supplierName: input.supplierName, name: input.name, adapterType: input.adapterType, baseUrl: input.baseUrl, enabled: input.enabled, alertEnabled: input.alertEnabled })]);
      return supplierConnection(row);
    });
  }

  async setSupplierConnectionAlertEnabled(connectionId, enabled, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const current = await client.query(`
        SELECT c.*,s.name AS supplier_name
        FROM ${this.schema}.supplier_connections c
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE c.id=$1
        FOR UPDATE OF c`, [connectionId]);
      if (!current.rowCount) throw httpError('supplier connection not found', 404);
      const updated = await client.query(`UPDATE ${this.schema}.supplier_connections
        SET alert_enabled=$2,updated_by=$3,updated_at=NOW()
        WHERE id=$1
        RETURNING *`, [connectionId,enabled,actor]);
      let resolvedAlertCount = 0;
      if (!enabled) {
        const resolved = await client.query(`UPDATE ${this.schema}.supplier_alert_events
          SET status='resolved',resolved_at=NOW(),last_seen_at=NOW()
          WHERE connection_id=$1 AND status='open'`, [connectionId]);
        resolvedAlertCount = resolved.rowCount;
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_connection_alert_enabled','supplier_connection',$2,$3::jsonb)`,
      [actor,String(connectionId),JSON.stringify({ alertEnabled: enabled, resolvedAlertCount })]);
      return {
        connection: supplierConnection({ ...updated.rows[0], supplier_name: current.rows[0].supplier_name }),
        resolvedAlertCount,
      };
    });
  }

  async getSupplierConnectionDeletionPlan(connectionId) {
    const result = await this.pool.query(`
      SELECT c.id,c.supplier_id,s.name,
             COALESCE(array_agg(DISTINCT l.source_account_id)
               FILTER (WHERE l.source_account_id IS NOT NULL), '{}') AS account_ids
      FROM ${this.schema}.supplier_connections c
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      LEFT JOIN ${this.schema}.supplier_keys k ON k.connection_id=c.id
      LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
      WHERE c.id=$1
      GROUP BY c.id,c.supplier_id,s.name`, [connectionId]);
    if (!result.rowCount) throw httpError('supplier connection not found', 404);
    return {
      connectionId: Number(result.rows[0].id),
      supplierId: Number(result.rows[0].supplier_id),
      supplierName: result.rows[0].name || '',
      accountIds: (result.rows[0].account_ids || []).map(Number).filter(Number.isSafeInteger),
    };
  }

  async getSupplierKeyDeletionPlan(keyId) {
    const result = await this.pool.query(`
      SELECT k.id,k.connection_id,k.name,k.external_key_id,
             COALESCE(array_agg(l.source_account_id)
               FILTER (WHERE l.source_account_id IS NOT NULL), '{}') AS account_ids
      FROM ${this.schema}.supplier_keys k
      LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
      WHERE k.id=$1
      GROUP BY k.id,k.connection_id,k.name,k.external_key_id`, [keyId]);
    if (!result.rowCount) throw httpError('supplier key not found', 404);
    return {
      keyId: Number(result.rows[0].id),
      connectionId: Number(result.rows[0].connection_id),
      keyName: result.rows[0].name || result.rows[0].external_key_id || '',
      accountIds: (result.rows[0].account_ids || []).map(Number).filter(Number.isSafeInteger),
    };
  }

  async deleteSupplierConnection(connectionId, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        SELECT c.id,c.supplier_id,s.name
        FROM ${this.schema}.supplier_connections c
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE c.id=$1
        FOR UPDATE OF c,s`, [connectionId]);
      if (!result.rowCount) throw httpError('supplier connection not found', 404);
      const connection = result.rows[0];
      const linkedAccounts = await client.query(`
        SELECT DISTINCT l.source_account_id
        FROM ${this.schema}.supplier_account_links l
        JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
        WHERE k.connection_id=$1`, [connectionId]);
      const accountIds = linkedAccounts.rows.map((row) => Number(row.source_account_id)).filter(Number.isSafeInteger);
      if (accountIds.length) {
        await client.query(`
          UPDATE ${this.schema}.account_cost_rules r
          SET effective_to=LEAST(COALESCE(r.effective_to,NOW()),NOW()),
              status='superseded',updated_at=NOW()
          FROM ${this.schema}.supplier_keys k
          WHERE r.supplier_key_id=k.id AND k.connection_id=$1
            AND r.status='active' AND r.effective_to IS NULL`, [connectionId]);
        await client.query(`
          UPDATE ${this.schema}.account_rate_observations r
          SET fresh_until=LEAST(COALESCE(r.fresh_until,NOW()),NOW())
          FROM ${this.schema}.supplier_keys k
          WHERE r.supplier_key_id=k.id AND k.connection_id=$1
            AND r.fresh_until>NOW()`, [connectionId]);
        await client.query(`
          UPDATE ${this.schema}.dim_accounts
          SET supplier='',purchase_batch='',synced_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
        await client.query(`
          UPDATE ${this.schema}.account_profit_guard_policies
          SET enabled=FALSE,last_error='supplier connection was deleted',updated_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
      }
      await client.query(`DELETE FROM ${this.schema}.supplier_connections WHERE id=$1`, [connectionId]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'delete_supplier_connection','supplier_connection',$2,$3::jsonb)`,
      [actor,String(connectionId),JSON.stringify({
        connectionId:Number(connectionId),supplierId:Number(connection.supplier_id),
        supplierName:connection.name || '',accountIds,
      })]);
      return {
        connectionId:Number(connectionId),supplierId:Number(connection.supplier_id),
        supplierName:connection.name || '',deleted:true,
      };
    });
  }

  async deleteSupplierKey(keyId, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const keyResult = await client.query(`
        SELECT k.id,k.connection_id,k.name,k.external_key_id,s.name AS supplier_name
        FROM ${this.schema}.supplier_keys k
        JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE k.id=$1
        FOR UPDATE OF k`, [keyId]);
      if (!keyResult.rowCount) throw httpError('supplier key not found', 404);
      const key = keyResult.rows[0];
      const linkedAccounts = await client.query(`
        SELECT source_account_id
        FROM ${this.schema}.supplier_account_links
        WHERE supplier_key_id=$1`, [keyId]);
      const accountIds = linkedAccounts.rows.map((row) => Number(row.source_account_id)).filter(Number.isSafeInteger);
      if (accountIds.length) {
        await client.query(`
          UPDATE ${this.schema}.account_cost_rules
          SET effective_to=LEAST(COALESCE(effective_to,NOW()),NOW()),
              status='superseded',updated_at=NOW()
          WHERE supplier_key_id=$1 AND status='active' AND effective_to IS NULL`, [keyId]);
        await client.query(`
          UPDATE ${this.schema}.account_rate_observations
          SET fresh_until=LEAST(COALESCE(fresh_until,NOW()),NOW())
          WHERE supplier_key_id=$1 AND fresh_until>NOW()`, [keyId]);
        await client.query(`
          UPDATE ${this.schema}.dim_accounts
          SET supplier='',purchase_batch='',synced_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
        await client.query(`
          UPDATE ${this.schema}.account_profit_guard_policies
          SET enabled=FALSE,last_error='supplier key was deleted',updated_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
      }
      await client.query(`DELETE FROM ${this.schema}.supplier_keys WHERE id=$1`, [keyId]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'delete_supplier_key','supplier_key',$2,$3::jsonb)`,
      [actor,String(keyId),JSON.stringify({
        keyId:Number(keyId),connectionId:Number(key.connection_id),
        supplierName:key.supplier_name || '',keyName:key.name || key.external_key_id || '',accountIds,
      })]);
      return {
        keyId:Number(keyId),connectionId:Number(key.connection_id),
        supplierName:key.supplier_name || '',keyName:key.name || key.external_key_id || '',deleted:true,
      };
    });
  }

  async updateSupplierConnectionCredentials(connectionId, credentialsCiphertext) {
    await this.pool.query(`
      UPDATE ${this.schema}.supplier_connections
      SET credentials_ciphertext=$2,updated_at=NOW()
      WHERE id=$1 AND auth_mode IN ('password','token_refresh')`, [connectionId, credentialsCiphertext]);
  }

  async listDueSupplierConnections(limit = 5) {
    const result = await this.pool.query(`
      SELECT c.*,s.name AS supplier_name
      FROM ${this.schema}.supplier_connections c JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      WHERE c.enabled AND c.next_sync_at<=NOW()
      ORDER BY c.next_sync_at,c.id LIMIT $1`, [limit]);
    return result.rows.map((row) => supplierConnection(row, { includeCiphertext: true }));
  }

  async listLinkedSupplierKeyExternalIds(connectionId) {
    const result = await this.pool.query(`
      SELECT DISTINCT k.external_key_id
      FROM ${this.schema}.supplier_account_links l
      JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
      WHERE k.connection_id=$1 AND k.removed_at IS NULL AND k.status='active'`, [connectionId]);
    return result.rows.map((row) => String(row.external_key_id));
  }

  qualityTarget(row, { includeCiphertext = false } = {}) {
    if (!row) return null;
    return {
      id: Number(row.id),
      connectionId: Number(row.connection_id),
      keyId: Number(row.supplier_key_id),
      externalKeyId: String(row.external_key_id || ''),
      keyName: row.key_name || '',
      maskedKey: row.masked_key || '',
      keyStatus: row.key_status || 'unknown',
      groupName: row.group_name || '',
      rateMultiplier: nullableNumber(row.rate_multiplier),
      model: row.model || '',
      enabled: Boolean(row.enabled),
      intervalSeconds: Number(row.interval_seconds || 1800),
      maxOutputTokens: Number(row.max_output_tokens || 1),
      nextProbeAt: row.next_probe_at || null,
      lastProbeAt: row.last_probe_at || null,
      lastStatus: row.last_status || 'pending',
      lastError: row.last_error || '',
      connection: row.base_url ? supplierConnection({
        ...row,
        id: row.connection_id,
        name: row.connection_name,
        enabled: row.connection_enabled,
        last_error: row.connection_last_error,
      }, { includeCiphertext }) : undefined,
    };
  }

  qualityObservation(row) {
    return {
      id: Number(row.id),
      sourceKind: row.source_kind,
      targetId: row.target_id ? Number(row.target_id) : null,
      keyId: row.supplier_key_id ? Number(row.supplier_key_id) : null,
      model: row.model || '',
      groupName: row.group_name || '',
      status: row.status,
      availabilitySample: Boolean(row.availability_sample),
      httpStatus: Number(row.http_status || 0),
      ttftMs: nullableNumber(row.ttft_ms),
      durationMs: nullableNumber(row.duration_ms),
      pingLatencyMs: nullableNumber(row.ping_latency_ms),
      rateMultiplier: nullableNumber(row.rate_multiplier),
      observedAt: row.observed_at || null,
      metadata: row.metadata || {},
    };
  }

  async listSupplierQualityTargets(connectionId) {
    const result = await this.pool.query(`
      SELECT t.*,c.supplier_id,c.name AS connection_name,c.adapter_type,c.detected_adapter_type,c.base_url,
             c.auth_mode,c.credential_label,c.credentials_ciphertext,c.enabled AS connection_enabled,
             c.inventory_interval_seconds,c.inventory_interval_minutes,c.active_check_enabled,c.active_check_limit,
             c.quality_monitor_mode,c.low_balance_threshold,c.balance_currency,c.connection_status,
             c.last_sync_at,c.last_success_at,c.next_sync_at,c.consecutive_failures,c.last_error AS connection_last_error,
             s.name AS supplier_name,k.external_key_id,k.name AS key_name,k.masked_key,
             k.status AS key_status,k.group_name,k.rate_multiplier
      FROM ${this.schema}.supplier_quality_targets t
      JOIN ${this.schema}.supplier_connections c ON c.id=t.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      JOIN ${this.schema}.supplier_keys k ON k.id=t.supplier_key_id
      WHERE t.connection_id=$1 AND k.removed_at IS NULL AND k.status='active'
      ORDER BY t.enabled DESC,t.next_probe_at,t.id`, [connectionId]);
    return { items: result.rows.map((row) => this.qualityTarget(row)) };
  }

  async getSupplierQualityTargetContext(targetId, { includeCiphertext = true } = {}) {
    const result = await this.pool.query(`
      SELECT t.*,c.supplier_id,c.name AS connection_name,c.adapter_type,c.detected_adapter_type,c.base_url,
             c.auth_mode,c.credential_label,c.credentials_ciphertext,c.enabled AS connection_enabled,
             c.inventory_interval_seconds,c.inventory_interval_minutes,c.active_check_enabled,c.active_check_limit,
             c.quality_monitor_mode,c.low_balance_threshold,c.balance_currency,c.connection_status,
             c.last_sync_at,c.last_success_at,c.next_sync_at,c.consecutive_failures,c.last_error AS connection_last_error,
             s.name AS supplier_name,k.external_key_id,k.name AS key_name,k.masked_key,
             k.status AS key_status,k.group_name,k.rate_multiplier
      FROM ${this.schema}.supplier_quality_targets t
      JOIN ${this.schema}.supplier_connections c ON c.id=t.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      JOIN ${this.schema}.supplier_keys k ON k.id=t.supplier_key_id
      WHERE t.id=$1 AND k.removed_at IS NULL AND k.status='active'`, [targetId]);
    if (!result.rowCount) throw httpError('supplier quality target not found', 404);
    return this.qualityTarget(result.rows[0], { includeCiphertext });
  }

  async getSupplierKeyContext(keyId, { includeCiphertext = true } = {}) {
    const result = await this.pool.query(`
      SELECT k.id AS supplier_key_id,k.external_key_id,k.name AS key_name,k.masked_key,k.status AS key_status,
             k.group_name,k.rate_multiplier,c.*,s.name AS supplier_name
      FROM ${this.schema}.supplier_keys k
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      WHERE k.id=$1 AND k.removed_at IS NULL AND k.status='active'`, [keyId]);
    if (!result.rowCount) throw httpError('supplier key not found', 404);
    return {
      keyId: Number(result.rows[0].supplier_key_id),
      externalKeyId: String(result.rows[0].external_key_id),
      keyName: result.rows[0].key_name || '',
      maskedKey: result.rows[0].masked_key || '',
      keyStatus: result.rows[0].key_status || 'unknown',
      groupName: result.rows[0].group_name || '',
      rateMultiplier: nullableNumber(result.rows[0].rate_multiplier),
      connection: supplierConnection(result.rows[0], { includeCiphertext }),
    };
  }

  async listDueSupplierQualityTargets(limit = 20) {
    const result = await this.pool.query(`
      SELECT t.*,c.supplier_id,c.name AS connection_name,c.adapter_type,c.detected_adapter_type,c.base_url,
             c.auth_mode,c.credential_label,c.credentials_ciphertext,c.enabled AS connection_enabled,
             c.inventory_interval_seconds,c.inventory_interval_minutes,c.active_check_enabled,c.active_check_limit,
             c.quality_monitor_mode,c.low_balance_threshold,c.balance_currency,c.connection_status,
             c.last_sync_at,c.last_success_at,c.next_sync_at,c.consecutive_failures,c.last_error AS connection_last_error,
             s.name AS supplier_name,k.external_key_id,k.name AS key_name,k.masked_key,
             k.status AS key_status,k.group_name,k.rate_multiplier
      FROM ${this.schema}.supplier_quality_targets t
      JOIN ${this.schema}.supplier_connections c ON c.id=t.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      JOIN ${this.schema}.supplier_keys k ON k.id=t.supplier_key_id
      WHERE t.enabled AND c.enabled AND c.quality_monitor_mode IN ('active','hybrid')
        AND t.next_probe_at<=NOW() AND k.removed_at IS NULL AND k.status='active'
      ORDER BY t.next_probe_at,t.id LIMIT $1`, [limit]);
    return result.rows.map((row) => this.qualityTarget(row, { includeCiphertext: true }));
  }

  async upsertSupplierQualityTarget(connectionId, input, actor = 'admin') {
    const targetId = await inTransaction(this.pool, async (client) => {
      const keyResult = await client.query(`
        SELECT id FROM ${this.schema}.supplier_keys
        WHERE id=$1 AND connection_id=$2 AND removed_at IS NULL`, [input.keyId, connectionId]);
      if (!keyResult.rowCount) throw httpError('supplier key is not available for this connection', 400);
      const result = await client.query(`
        INSERT INTO ${this.schema}.supplier_quality_targets(
          connection_id,supplier_key_id,model,enabled,interval_seconds,max_output_tokens,
          next_probe_at,last_status,last_error,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $4 THEN NOW() ELSE NOW()+$5*INTERVAL '1 second' END,
          CASE WHEN $4 THEN 'pending' ELSE 'disabled' END,'',$7,$7)
        ON CONFLICT(supplier_key_id,model) DO UPDATE SET
          connection_id=EXCLUDED.connection_id,enabled=EXCLUDED.enabled,
          interval_seconds=EXCLUDED.interval_seconds,max_output_tokens=EXCLUDED.max_output_tokens,
          next_probe_at=CASE WHEN EXCLUDED.enabled THEN LEAST(
            supplier_quality_targets.next_probe_at,EXCLUDED.next_probe_at)
            ELSE supplier_quality_targets.next_probe_at END,
          last_status=CASE WHEN EXCLUDED.enabled THEN
            CASE WHEN supplier_quality_targets.last_status='disabled' THEN 'pending' ELSE supplier_quality_targets.last_status END
            ELSE 'disabled' END,
          updated_by=EXCLUDED.updated_by,updated_at=NOW()
        RETURNING id`, [
        connectionId,input.keyId,input.model,input.enabled,input.intervalSeconds,input.maxOutputTokens,actor,
      ]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'upsert_supplier_quality_target','supplier_quality_target',$2,$3::jsonb)`,
      [actor,String(result.rows[0].id),JSON.stringify({
        connectionId, keyId: input.keyId, model: input.model, enabled: input.enabled,
        intervalSeconds: input.intervalSeconds, maxOutputTokens: input.maxOutputTokens,
      })]);
      return Number(result.rows[0].id);
    });
    return this.getSupplierQualityTargetContext(targetId);
  }

  async updateSupplierQualityTarget(targetId, input, actor = 'admin') {
    const updatedId = await inTransaction(this.pool, async (client) => {
      const current = await client.query(`
        SELECT connection_id FROM ${this.schema}.supplier_quality_targets WHERE id=$1 FOR UPDATE`, [targetId]);
      if (!current.rowCount) throw httpError('supplier quality target not found', 404);
      const key = await client.query(`
        SELECT id FROM ${this.schema}.supplier_keys
        WHERE id=$1 AND connection_id=$2 AND removed_at IS NULL`, [input.keyId, current.rows[0].connection_id]);
      if (!key.rowCount) throw httpError('supplier key is not available for this connection', 400);
      try {
        await client.query(`
          UPDATE ${this.schema}.supplier_quality_targets SET
            supplier_key_id=$2,model=$3,enabled=$4,interval_seconds=$5,max_output_tokens=$6,
            next_probe_at=CASE WHEN $4 THEN LEAST(next_probe_at,NOW()) ELSE next_probe_at END,
            last_status=CASE WHEN $4 THEN CASE WHEN last_status='disabled' THEN 'pending' ELSE last_status END ELSE 'disabled' END,
            last_error=CASE WHEN $4 THEN last_error ELSE '' END,updated_by=$7,updated_at=NOW()
          WHERE id=$1`, [targetId,input.keyId,input.model,input.enabled,input.intervalSeconds,input.maxOutputTokens,actor]);
      } catch (error) {
        if (error?.code === '23505') throw httpError('this supplier key and model target already exists', 409);
        throw error;
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_quality_target','supplier_quality_target',$2,$3::jsonb)`,
      [actor,String(targetId),JSON.stringify(input)]);
      return Number(targetId);
    });
    return this.getSupplierQualityTargetContext(updatedId);
  }

  async deleteSupplierQualityTarget(targetId, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        DELETE FROM ${this.schema}.supplier_quality_targets
        WHERE id=$1 RETURNING id,connection_id,model`, [targetId]);
      if (!result.rowCount) throw httpError('supplier quality target not found', 404);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'delete_supplier_quality_target','supplier_quality_target',$2,$3::jsonb)`,
      [actor,String(targetId),JSON.stringify(result.rows[0])]);
      return { id: Number(targetId), deleted: true };
    });
  }

  async recordSupplierQualityObservations(connectionId, observations = []) {
    if (!observations.length) return { inserted: 0 };
    return inTransaction(this.pool, async (client) => {
      const keys = await client.query(`
        SELECT id,external_key_id FROM ${this.schema}.supplier_keys WHERE connection_id=$1`, [connectionId]);
      const keyIds = new Map(keys.rows.map((row) => [String(row.external_key_id), Number(row.id)]));
      let inserted = 0;
      for (const observation of observations) {
        const status = normalizeQualityStatus(observation.status);
        const result = await client.query(`
          INSERT INTO ${this.schema}.supplier_quality_observations(
            connection_id,supplier_key_id,target_id,source_kind,external_observation_id,model,group_name,
            status,availability_sample,http_status,ttft_ms,duration_ms,ping_latency_ms,rate_multiplier,
            observed_at,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
          ON CONFLICT(connection_id,source_kind,external_observation_id)
          WHERE external_observation_id IS NOT NULL
          DO NOTHING`,
        [
          connectionId,
          observation.keyId || keyIds.get(String(observation.keyExternalId || '')) || null,
          observation.targetId || null,
          observation.sourceKind,
          observation.externalObservationId || null,
          String(observation.model || '').slice(0, 200),
          String(observation.groupName || '').slice(0, 200),
          status,
          Boolean(observation.availabilitySample),
          Number(observation.httpStatus || 0),
          observation.ttftMs === null || observation.ttftMs === undefined ? null : Math.max(0, Math.round(Number(observation.ttftMs))),
          observation.durationMs === null || observation.durationMs === undefined ? null : Math.max(0, Math.round(Number(observation.durationMs))),
          observation.pingLatencyMs === null || observation.pingLatencyMs === undefined ? null : Math.max(0, Math.round(Number(observation.pingLatencyMs))),
          observation.rateMultiplier === null || observation.rateMultiplier === undefined ? null : observation.rateMultiplier,
          observation.observedAt || new Date().toISOString(),
          JSON.stringify(observation.metadata || {}),
        ]);
        inserted += result.rowCount;
      }
      return { inserted };
    });
  }

  async recordSupplierQualityTargetResult(targetId, observation) {
    const resultTargetId = await inTransaction(this.pool, async (client) => {
      const target = await client.query(`
        SELECT id,connection_id,supplier_key_id,interval_seconds FROM ${this.schema}.supplier_quality_targets
        WHERE id=$1 FOR UPDATE`, [targetId]);
      if (!target.rowCount) throw httpError('supplier quality target not found', 404);
      const status = normalizeQualityStatus(observation.status);
      const errorMessage = observation.errorMessage || observation.errorCode
        ? supplierUserMessage(observation.errorMessage || observation.errorCode || '', {
          code: observation.errorCode || '', httpStatus: observation.httpStatus || 0,
        })
        : '';
      await client.query(`
        INSERT INTO ${this.schema}.supplier_quality_observations(
          connection_id,supplier_key_id,target_id,source_kind,external_observation_id,model,group_name,
          status,availability_sample,http_status,ttft_ms,duration_ms,ping_latency_ms,rate_multiplier,
          observed_at,metadata)
        VALUES($1,$2,$3,'active_probe',$4,$5,$6,$7,TRUE,$8,$9,$10,$11,$12,$13,$14::jsonb)
        ON CONFLICT(connection_id,source_kind,external_observation_id)
        WHERE external_observation_id IS NOT NULL
        DO NOTHING`, [
        target.rows[0].connection_id,target.rows[0].supplier_key_id,targetId,
        `active:${targetId}:${observation.observedAt || new Date().toISOString()}`,
        observation.model || '',observation.groupName || '',status,Number(observation.httpStatus || 0),
        observation.ttftMs === null || observation.ttftMs === undefined ? null : Math.max(0, Math.round(Number(observation.ttftMs))),
        observation.durationMs === null || observation.durationMs === undefined ? null : Math.max(0, Math.round(Number(observation.durationMs))),
        observation.pingLatencyMs === null || observation.pingLatencyMs === undefined ? null : Math.max(0, Math.round(Number(observation.pingLatencyMs))),
        observation.rateMultiplier === null || observation.rateMultiplier === undefined ? null : observation.rateMultiplier,
        observation.observedAt || new Date().toISOString(),
        JSON.stringify({ errorCode: observation.errorCode || '', errorMessage, ...(observation.metadata || {}) }),
      ]);
      await client.query(`
        UPDATE ${this.schema}.supplier_quality_targets
        SET last_probe_at=NOW(),last_status=$2,last_error=$3,
            next_probe_at=NOW()+interval_seconds*INTERVAL '1 second',updated_at=NOW()
        WHERE id=$1`, [targetId,status,errorMessage.slice(0, 1000)]);
      return Number(targetId);
    });
    return this.getSupplierQualityTargetContext(resultTargetId);
  }

  async loadSupplierQualityObservationMetrics(windowStart, windowEnd) {
    const levelSql = `CASE
      WHEN GROUPING(model)=1 THEN 'connection'
      WHEN GROUPING(supplier_key_id)=1 THEN 'model'
      ELSE 'unit'
    END`;
    const groupSql = `GROUP BY GROUPING SETS (
      (connection_id),
      (connection_id,model),
      (connection_id,model,supplier_key_id)
    )`;
    const [countsResult, latencyResult, probesResult] = await Promise.all([
      this.pool.query(`
        SELECT ${levelSql} AS level,connection_id,
               CASE WHEN GROUPING(model)=1 THEN '' ELSE model END AS model,
               CASE WHEN GROUPING(supplier_key_id)=1 THEN NULL ELSE supplier_key_id END AS key_id,
               COUNT(*)::bigint AS sample_count,
               COUNT(*) FILTER (WHERE availability_sample)::bigint AS availability_samples,
               COUNT(*) FILTER (WHERE availability_sample AND status='ok')::bigint AS success_samples,
               COUNT(*) FILTER (WHERE status='failed')::bigint AS failure_count,
               MAX(observed_at) AS last_observed_at,
               MAX(observed_at) FILTER (WHERE availability_sample AND status='ok') AS last_success_at,
               COUNT(*) FILTER (WHERE source_kind='passive_usage')::bigint AS passive_usage_samples,
               COUNT(*) FILTER (WHERE source_kind='passive_monitor')::bigint AS passive_monitor_samples,
               COUNT(*) FILTER (WHERE source_kind='active_probe')::bigint AS active_probe_samples,
               MAX(rate_multiplier) FILTER (WHERE status='ok' AND rate_multiplier>0) AS latest_rate_multiplier,
               MAX(rate_multiplier) FILTER (
                 WHERE status='ok' AND source_kind='passive_usage' AND rate_multiplier>0
               ) AS latest_passive_rate_multiplier
        FROM ${this.schema}.supplier_quality_observations
        WHERE observed_at>=$1 AND observed_at<$2
        ${groupSql}`, [windowStart, windowEnd]),
      this.pool.query(`
        SELECT ${levelSql} AS level,connection_id,
               CASE WHEN GROUPING(model)=1 THEN '' ELSE model END AS model,
               CASE WHEN GROUPING(supplier_key_id)=1 THEN NULL ELSE supplier_key_id END AS key_id,
               COUNT(*)::bigint AS ttft_samples,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p95_ms
        FROM ${this.schema}.supplier_quality_observations
        WHERE observed_at>=$1 AND observed_at<$2 AND ttft_ms IS NOT NULL
        ${groupSql}`, [windowStart, windowEnd]),
      this.pool.query(`
        SELECT connection_id,model,supplier_key_id,status,observed_at,id
        FROM ${this.schema}.supplier_quality_observations
        WHERE observed_at>=$1 AND observed_at<$2 AND source_kind='active_probe'
        ORDER BY observed_at DESC,id DESC`, [windowStart, windowEnd]),
    ]);
    const metricKey = (level, connectionId, model = '', keyId = null) => (
      `${level}\u0000${Number(connectionId)}\u0000${String(model || '').trim()}\u0000${keyId === null || keyId === undefined ? '' : Number(keyId)}`
    );
    const metrics = countsResult.rows.map((row) => ({
      level: row.level,
      connectionId: Number(row.connection_id),
      model: row.model || '',
      keyId: row.key_id === null ? null : Number(row.key_id),
      sampleCount: Number(row.sample_count || 0),
      availabilitySamples: Number(row.availability_samples || 0),
      successSamples: Number(row.success_samples || 0),
      failureCount: Number(row.failure_count || 0),
      ttftSamples: 0,
      ttftP50Ms: null,
      ttftP95Ms: null,
      lastObservedAt: row.last_observed_at || null,
      lastSuccessAt: row.last_success_at || null,
      consecutiveFailures: 0,
      passiveUsageSamples: Number(row.passive_usage_samples || 0),
      passiveMonitorSamples: Number(row.passive_monitor_samples || 0),
      activeProbeSamples: Number(row.active_probe_samples || 0),
      latestRateMultiplier: nullableNumber(row.latest_rate_multiplier),
      latestPassiveRateMultiplier: nullableNumber(row.latest_passive_rate_multiplier),
    }));
    const metricsByKey = new Map(metrics.map((item) => [
      metricKey(item.level, item.connectionId, item.model, item.keyId),
      item,
    ]));
    for (const row of latencyResult.rows) {
      const metric = metricsByKey.get(metricKey(
        row.level,
        row.connection_id,
        row.model,
        row.key_id === null ? null : row.key_id,
      ));
      if (!metric) continue;
      metric.ttftSamples = Number(row.ttft_samples || 0);
      metric.ttftP50Ms = nullableNumber(row.ttft_p50_ms);
      metric.ttftP95Ms = nullableNumber(row.ttft_p95_ms);
    }
    const probeStatuses = new Map();
    for (const row of probesResult.rows) {
      const keys = [
        metricKey('connection', row.connection_id),
        metricKey('model', row.connection_id, row.model),
        metricKey('unit', row.connection_id, row.model, row.supplier_key_id === null ? null : row.supplier_key_id),
      ];
      for (const key of keys) {
        const statuses = probeStatuses.get(key) || [];
        statuses.push(row.status);
        probeStatuses.set(key, statuses);
      }
    }
    for (const [key, statuses] of probeStatuses) {
      const metric = metricsByKey.get(key);
      if (!metric) continue;
      let failures = 0;
      for (const status of statuses) {
        if (status !== 'failed') break;
        failures += 1;
      }
      metric.consecutiveFailures = failures;
    }
    return metrics;
  }

  async loadSupplierQualityScores({ start, end, dailyStart = start, dailyEnd = end } = {}) {
    const windowStart = start || new Date(Date.now() - 7 * 86_400_000);
    const windowEnd = end || new Date();
    const [connectionsResult, observationMetrics, keysResult, targetsResult, usageResult] = await Promise.all([
      this.pool.query(`
        WITH keys AS (
          SELECT connection_id,
                 COUNT(*) FILTER (WHERE removed_at IS NULL)::int AS key_count,
                 COUNT(*) FILTER (WHERE removed_at IS NULL AND status='active')::int AS active_key_count,
                 COUNT(*) FILTER (WHERE removed_at IS NULL AND last_check_status='failed')::int AS failed_key_count
          FROM ${this.schema}.supplier_keys
          GROUP BY connection_id
        ),
        alerts AS (
          SELECT connection_id,COUNT(*) FILTER (WHERE status='open')::int AS open_alert_count
          FROM ${this.schema}.supplier_alert_events
          GROUP BY connection_id
        ),
        targets AS (
          SELECT connection_id,COUNT(*) FILTER (WHERE enabled)::int AS enabled_target_count
          FROM ${this.schema}.supplier_quality_targets
          GROUP BY connection_id
        )
        SELECT c.*,s.name AS supplier_name,b.balance,
               COALESCE(keys.key_count,0)::int AS key_count,
               COALESCE(keys.active_key_count,0)::int AS active_key_count,
               COALESCE(keys.failed_key_count,0)::int AS failed_key_count,
               COALESCE(alerts.open_alert_count,0)::int AS open_alert_count,
               COALESCE(targets.enabled_target_count,0)::int AS enabled_target_count
        FROM ${this.schema}.supplier_connections c
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        LEFT JOIN LATERAL (
          SELECT balance FROM ${this.schema}.supplier_balance_snapshots
          WHERE connection_id=c.id ORDER BY observed_at DESC,id DESC LIMIT 1
        ) b ON TRUE
        LEFT JOIN keys ON keys.connection_id=c.id
        LEFT JOIN alerts ON alerts.connection_id=c.id
        LEFT JOIN targets ON targets.connection_id=c.id
        ORDER BY s.name,c.name`),
      this.loadSupplierQualityObservationMetrics(windowStart, windowEnd),
      this.pool.query(`
        SELECT id,connection_id,name,masked_key,group_name,status,removed_at,rate_multiplier,
               last_check_status,last_check_at
         FROM ${this.schema}.supplier_keys
         WHERE removed_at IS NULL AND status='active'`),
      this.pool.query(`
        SELECT t.id,t.connection_id,t.supplier_key_id,t.model,t.enabled,t.last_status,t.last_probe_at
        FROM ${this.schema}.supplier_quality_targets t
        JOIN ${this.schema}.supplier_keys k ON k.id=t.supplier_key_id
        WHERE k.removed_at IS NULL AND k.status='active'`),
      this.pool.query(`
        SELECT k.connection_id,k.id AS supplier_key_id,d.model,SUM(d.user_charge_cny) AS amount
         FROM ${this.schema}.fact_usage_daily d
         JOIN ${this.schema}.supplier_account_links l ON l.source_account_id=d.source_account_id
         JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
         WHERE d.day>=$1::date AND d.day<=$2::date AND NULLIF(BTRIM(d.model),'') IS NOT NULL
           AND k.removed_at IS NULL AND k.status='active'
         GROUP BY k.connection_id,k.id,d.model`, [dailyStart, dailyEnd]),
    ]);
    const connectionRows = new Map(connectionsResult.rows.map((row) => [Number(row.id), row]));
    const scores = buildSupplierQualityScores({
      connections: connectionsResult.rows.map((row) => supplierConnection(row)),
      observationMetrics,
      keys: keysResult.rows.map((row) => ({
        id: Number(row.id),
        connectionId: Number(row.connection_id),
        name: row.name || '',
        maskedKey: row.masked_key || '',
        groupName: row.group_name || '',
        status: row.status,
        removedAt: row.removed_at || null,
        rateMultiplier: nullableNumber(row.rate_multiplier),
        lastCheckStatus: row.last_check_status || '',
        lastCheckAt: row.last_check_at || null,
      })),
      targets: targetsResult.rows.map((row) => ({
        id: Number(row.id),
        connectionId: Number(row.connection_id),
        keyId: Number(row.supplier_key_id),
        model: row.model || '',
        enabled: Boolean(row.enabled),
        lastStatus: row.last_status || 'pending',
        lastProbeAt: row.last_probe_at || null,
      })),
      usageWeights: usageResult.rows.map((row) => ({
        connectionId: Number(row.connection_id),
        keyId: Number(row.supplier_key_id),
        model: row.model || '',
        amount: Number(row.amount || 0),
      })),
    });
    return scores.map((item) => ({
      ...item,
      metrics: {
        ...item.metrics,
        enabledTargetCount: Number(connectionRows.get(Number(item.connection.id))?.enabled_target_count || 0),
      },
    }));
  }

  async getSupplierQualityDashboard(connectionId, range = {}) {
    const items = await this.loadSupplierQualityScores(range);
    const dashboard = items.find((item) => Number(item.connection.id) === Number(connectionId));
    if (!dashboard) throw httpError('supplier connection not found', 404);
    return {
      score: dashboard.score,
      metrics: dashboard.metrics,
      models: dashboard.models,
      observations: (await this.pool.query(`
        SELECT id,connection_id,source_kind,target_id,supplier_key_id,model,group_name,status,
               availability_sample,http_status,ttft_ms,duration_ms,ping_latency_ms,rate_multiplier,
               observed_at,metadata
        FROM ${this.schema}.supplier_quality_observations
         WHERE connection_id=$1 AND observed_at>=$2 AND observed_at<$3
         ORDER BY observed_at DESC,id DESC LIMIT 100`, [connectionId, range.start || new Date(Date.now() - 7 * 86_400_000), range.end || new Date()]))
        .rows.map((row) => this.qualityObservation(row)),
    };
  }

  async listSupplierQualityOverview(range = {}) {
    return { items: await this.loadSupplierQualityScores(range) };
  }

  async recordSupplierSyncFailure(connectionId, error) {
    return inTransaction(this.pool, async (client) => {
      const message = supplierUserMessage(error?.message || '供应商同步失败', {
        code: error?.code || 'sync_failed', httpStatus: error?.httpStatus || 0,
      });
      const result = await client.query(`
        UPDATE ${this.schema}.supplier_connections SET
          connection_status=CASE WHEN $2='unsupported_site' OR $2='adapter_required' THEN 'unsupported' ELSE 'failed' END,
          last_sync_at=NOW(),consecutive_failures=consecutive_failures+1,last_error=$3,
          next_sync_at=NOW()+LEAST(INTERVAL '24 hours',
            inventory_interval_seconds*INTERVAL '1 second' * POWER(2,LEAST(consecutive_failures+1,6))),updated_at=NOW()
        WHERE id=$1 RETURNING *`, [connectionId,error.code || 'sync_failed',message.slice(0,1000)]);
      if (!result.rowCount) return;
      if (result.rows[0].alert_enabled === false) return;
      await client.query(`
        INSERT INTO ${this.schema}.supplier_alert_events(
          connection_id,dedupe_key,alert_type,severity,title,message,details)
        VALUES($1,'connection:sync_failed','sync_failed','critical','供应商连接同步失败',$2,$3::jsonb)
        ON CONFLICT(connection_id,dedupe_key) DO UPDATE SET
          status='open',severity='critical',message=EXCLUDED.message,details=EXCLUDED.details,
          last_seen_at=NOW(),occurrence_count=supplier_alert_events.occurrence_count+1,
          resolved_at=NULL`, [connectionId,message.slice(0,1000),JSON.stringify({ code: error.code || 'sync_failed', httpStatus: error.httpStatus || 0 })]);
    });
  }

  async recordSupplierSyncSuccess(connectionId, snapshot, checks) {
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('apistation_finops_dimension_writes'))");
      const connectionResult = await client.query(`
        SELECT c.*,s.name AS supplier_name
        FROM ${this.schema}.supplier_connections c
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE c.id=$1
        FOR UPDATE OF c`, [connectionId]);
      if (!connectionResult.rowCount) throw httpError('supplier connection not found', 404);
      const connection = connectionResult.rows[0];
      const previousResult = await client.query(`SELECT * FROM ${this.schema}.supplier_keys WHERE connection_id=$1 FOR UPDATE`, [connectionId]);
      const previousByExternalId = new Map(previousResult.rows.map((row) => [row.external_key_id, row]));
      const seen = [];
      const alert = async ({ keyId = null, dedupeKey, type, severity = 'warning', title, message = '', details = {} }) => {
        if (connection.alert_enabled === false) return;
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
           VALUES($1,$2,$3,$4,$5,$6::text,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW(),
             CASE WHEN $6::text IN ('removed','deleted') THEN NOW() ELSE NULL END)
          ON CONFLICT(connection_id,external_key_id) DO UPDATE SET
            name=EXCLUDED.name,masked_key=EXCLUDED.masked_key,
            key_fingerprint=CASE WHEN EXCLUDED.key_fingerprint='' THEN ${this.schema}.supplier_keys.key_fingerprint ELSE EXCLUDED.key_fingerprint END,
            status=EXCLUDED.status,group_id=EXCLUDED.group_id,group_name=EXCLUDED.group_name,
            rate_multiplier=EXCLUDED.rate_multiplier,quota_total=EXCLUDED.quota_total,quota_used=EXCLUDED.quota_used,
            quota_remaining=EXCLUDED.quota_remaining,quota_currency=EXCLUDED.quota_currency,
            expires_at=EXCLUDED.expires_at,last_used_at=EXCLUDED.last_used_at,source_data=EXCLUDED.source_data,
             last_seen_at=NOW(),
             removed_at=CASE WHEN EXCLUDED.status::text IN ('removed','deleted')
               THEN COALESCE(${this.schema}.supplier_keys.removed_at,NOW())
               ELSE NULL END,
             updated_at=NOW()
          RETURNING *`, [
          connectionId,item.externalId,item.name,item.maskedKey,item.keyFingerprint || '',item.status,
          item.groupId,item.groupName,item.rateMultiplier,item.quotaTotal,item.quotaUsed,item.quotaRemaining,
          item.quotaCurrency,item.expiresAt,item.lastUsedAt,JSON.stringify(item.sourceData || {}),
        ]);
        const key = keyResult.rows[0];
        await client.query(`
          UPDATE ${this.schema}.dim_accounts a
          SET supplier=$2,purchase_batch=$3,synced_at=NOW()
          FROM ${this.schema}.supplier_account_links l
          WHERE l.supplier_key_id=$1 AND l.source_account_id=a.source_account_id`,
        [key.id,connection.supplier_name,supplierKeyPurchaseBatch(key)]);
        const multiplierChanged = previous && nullableNumber(previous.rate_multiplier) !== nullableNumber(item.rateMultiplier);
        const statusChanged = previous && previous.status !== item.status;
        const groupChanged = previous && (previous.group_id !== item.groupId || previous.group_name !== item.groupName);
        const changeType = !previous
          ? 'discovered'
          : multiplierChanged
          ? 'multiplier_changed'
          : statusChanged
          ? 'status_changed'
          : 'group_changed';
        if (!previous || multiplierChanged || statusChanged || groupChanged) {
          await client.query(`INSERT INTO ${this.schema}.supplier_key_observations(
            supplier_key_id,status,group_name,rate_multiplier,quota_remaining,change_type,snapshot_data)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [key.id,item.status,item.groupName,item.rateMultiplier,item.quotaRemaining,changeType,JSON.stringify(item.sourceData || {})]);
        }
        if (multiplierChanged) await alert({
          keyId:key.id,dedupeKey:`key:${key.id}:multiplier`,type:'multiplier_changed',title:'密钥倍率发生变化',
          message:`${item.name || item.maskedKey}：${previous.rate_multiplier ?? '--'}x → ${item.rateMultiplier ?? '--'}x`,
          details:{ previous:nullableNumber(previous.rate_multiplier), current:nullableNumber(item.rateMultiplier) },
        });
        if (statusChanged && item.status !== 'active') await alert({
          keyId:key.id,dedupeKey:`key:${key.id}:portal_status`,type:'key_status_changed',title:'密钥状态异常',
          message:`${item.name || item.maskedKey} 当前状态：${item.status}`,details:{ previous:previous.status,current:item.status },
        });
        if (item.status === 'active') {
          await resolveAlert(`key:${key.id}:portal_status`);
          await resolveAlert(`key:${key.id}:removed`);
        }

        const check = checks.find((candidate) => candidate.externalId === item.externalId);
        if (check) {
          const checkMessage = check.errorMessage || check.errorCode
            ? supplierUserMessage(check.errorMessage || check.errorCode || '', {
              code: check.errorCode || '', httpStatus: check.httpStatus || 0,
            })
            : '';
          await client.query(`INSERT INTO ${this.schema}.supplier_key_checks(
            supplier_key_id,status,method,http_status,latency_ms,error_code,error_message)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [key.id,check.status,check.method,check.httpStatus || 0,check.latencyMs ?? null,check.errorCode || '',checkMessage.slice(0,1000)]);
          await client.query(`UPDATE ${this.schema}.supplier_keys SET
            last_check_status=$2,last_check_method=$3,last_check_at=NOW(),last_check_error=$4,updated_at=NOW()
            WHERE id=$1`, [key.id,check.status,check.method,checkMessage.slice(0,1000)]);
          if (check.status === 'failed') await alert({
            keyId:key.id,dedupeKey:`key:${key.id}:check`,type:'key_check_failed',severity:'critical',title:'密钥巡检失败',
            message:`${item.name || item.maskedKey}：${checkMessage}`,
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
              SELECT $1,$2,'supplier_direct_probe','ok','token',$3,NOW(),
                NOW()+($4*2)*INTERVAL '1 second',NOW(),NOW()+$4*INTERVAL '1 second',0,$5,'',
                $6,$7,$8,$9,$10,$11,$12,$13::varchar(80),$14::jsonb,$15
              WHERE NOT EXISTS (
                SELECT 1
                FROM (
                  SELECT status,billing_scope,group_rate_multiplier,user_rate_multiplier,
                         resolved_rate_multiplier,effective_rate_multiplier,peak_rate_enabled,
                         peak_rate_multiplier,applied_peak_multiplier,timezone,snapshot_data
                  FROM ${this.schema}.account_rate_observations
                  WHERE source_account_id=$1 AND supplier_key_id=$15
                    AND source_kind='supplier_direct_probe'
                  ORDER BY COALESCE(observed_at,received_at,last_attempt_at,captured_at) DESC,id DESC
                  LIMIT 1
                ) previous
                WHERE previous.status IS NOT DISTINCT FROM 'ok'
                  AND previous.billing_scope IS NOT DISTINCT FROM 'token'
                  AND previous.group_rate_multiplier IS NOT DISTINCT FROM $6
                  AND previous.user_rate_multiplier IS NOT DISTINCT FROM $7
                  AND previous.resolved_rate_multiplier IS NOT DISTINCT FROM $8
                  AND previous.effective_rate_multiplier IS NOT DISTINCT FROM $9
                  AND previous.peak_rate_enabled IS NOT DISTINCT FROM $10
                  AND previous.peak_rate_multiplier IS NOT DISTINCT FROM $11
                  AND previous.applied_peak_multiplier IS NOT DISTINCT FROM $12
                  AND previous.timezone IS NOT DISTINCT FROM $13::varchar(80)
                  AND previous.snapshot_data->>'peak_start'
                    IS NOT DISTINCT FROM $14::jsonb->>'peak_start'
                  AND previous.snapshot_data->>'peak_end'
                    IS NOT DISTINCT FROM $14::jsonb->>'peak_end'
              )
              ON CONFLICT(source_account_id,observation_key) DO NOTHING`, [
              link.source_account_id,`supplier:${key.id}:${observedAt}`,observedAt,connection.inventory_interval_seconds,
              check.httpStatus || 200,check.billing.group_rate_multiplier,check.billing.user_rate_multiplier,
              check.billing.resolved_rate_multiplier,check.billing.effective_rate_multiplier,
              check.billing.peak_rate_enabled,check.billing.peak_rate_multiplier,check.billing.applied_peak_multiplier,
              check.billing.timezone || '',JSON.stringify(check.billing),key.id,
            ]);
          }
        }
      }

      const explicitlyRemoved = new Set(snapshot.keys
        .filter((item) => ['removed', 'deleted'].includes(String(item.status || '').toLowerCase()))
        .map((item) => String(item.externalId)));
      const removed = previousResult.rows.filter((row) => (
        !row.removed_at
        && (!seen.includes(row.external_key_id) || explicitlyRemoved.has(String(row.external_key_id)))
      ));
      if (seen.length) await client.query(`UPDATE ${this.schema}.supplier_keys
        SET removed_at=NOW(),status='removed',updated_at=NOW()
        WHERE connection_id=$1 AND NOT (external_key_id=ANY($2::text[])) AND removed_at IS NULL`, [connectionId,seen]);
      else await client.query(`UPDATE ${this.schema}.supplier_keys
        SET removed_at=NOW(),status='removed',updated_at=NOW() WHERE connection_id=$1 AND removed_at IS NULL`, [connectionId]);
      for (const key of removed) await alert({
        keyId:key.id,dedupeKey:`key:${key.id}:removed`,type:'key_removed',title:'供应商密钥已移除',
        message:`${key.name || key.masked_key} 已不在供应商返回的密钥列表中`,
      });

      for (const key of removed) {
        const linkedAccounts = await client.query(`
          SELECT l.source_account_id,a.name AS account_name
          FROM ${this.schema}.supplier_account_links l
          LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
          WHERE l.supplier_key_id=$1
          FOR UPDATE OF l`, [key.id]);
        await client.query(`
          UPDATE ${this.schema}.supplier_quality_targets
          SET enabled=FALSE,last_status='disabled',last_error='supplier key was removed',updated_at=NOW()
          WHERE supplier_key_id=$1`, [key.id]);
        const accountIds = linkedAccounts.rows.map((row) => Number(row.source_account_id));
        if (!accountIds.length) continue;

        // Keep historical usage/cost snapshots intact, but stop using a removed
        // supplier key for all future account costing and monitoring.
        await client.query(`
          UPDATE ${this.schema}.account_cost_rules
          SET effective_to=NOW(),status='superseded',updated_at=NOW()
          WHERE source_account_id=ANY($1::bigint[]) AND supplier_key_id=$2
            AND status='active' AND effective_to IS NULL`, [accountIds, key.id]);
        await client.query(`
          UPDATE ${this.schema}.account_rate_observations
          SET fresh_until=LEAST(COALESCE(fresh_until,NOW()),NOW())
          WHERE source_account_id=ANY($1::bigint[]) AND supplier_key_id=$2
            AND fresh_until>NOW()`, [accountIds, key.id]);
        await client.query(`
          UPDATE ${this.schema}.dim_accounts
          SET supplier='',purchase_batch='',synced_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
        await client.query(`
          UPDATE ${this.schema}.account_profit_guard_policies
          SET enabled=FALSE,last_error='upstream supplier key was removed',updated_at=NOW()
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]);
        await client.query(`
          DELETE FROM ${this.schema}.supplier_account_links
          WHERE supplier_key_id=$1 AND source_account_id=ANY($2::bigint[])`, [key.id, accountIds]);

        for (const account of linkedAccounts.rows) {
          await alert({
            keyId: key.id,
            dedupeKey: `account:${account.source_account_id}:supplier-key:${key.id}:removed`,
            type: 'account_supplier_key_removed',
            severity: 'critical',
            title: '\u4e0a\u6e38\u5bc6\u94a5\u5df2\u79fb\u9664\uff0c\u8d26\u53f7\u5df2\u89e3\u9664\u4f9b\u5e94\u5546\u5173\u8054',
            message: `${account.account_name || `\u8d26\u53f7 ${account.source_account_id}`} \u5df2\u4ece\u4f9b\u5e94\u5546\u5bc6\u94a5\u6240\u5728\u7684\u6210\u672c\u89c4\u5219\u4e2d\u89e3\u9664\uff0c\u672a\u6765\u6d88\u8d39\u9700\u8981\u91cd\u65b0\u914d\u7f6e\u6210\u672c`,
            details: {
              accountId: Number(account.source_account_id),
              accountName: account.account_name || '',
              supplierKeyId: Number(key.id),
              supplierKeyName: key.name || key.masked_key || '',
            },
          });
        }
      }

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
        balance_currency=$5,last_sync_at=NOW(),last_success_at=NOW(),next_sync_at=NOW()+inventory_interval_seconds*INTERVAL '1 second',
        consecutive_failures=0,last_error='',updated_at=NOW() WHERE id=$1`,
      [connectionId,failedChecks ? 'warning' : 'ok',snapshot.adapterType,snapshot.identity || '',snapshot.balanceCurrency || connection.balance_currency]);
    });
  }

  async getSupplierConnectionDetails(connectionId) {
    const connection = await this.getSupplierConnection(connectionId);
    const client = await this.pool.connect();
    let keys;
    let balances;
    let checks;
    let alerts;
    let links;
    try {
      keys = await client.query(`SELECT id,external_key_id,name,masked_key,status,group_id,group_name,rate_multiplier,
        quota_total,quota_used,quota_remaining,quota_currency,expires_at,last_used_at,last_check_status,
        last_check_method,last_check_at,last_check_error,first_seen_at,last_seen_at,removed_at
        FROM ${this.schema}.supplier_keys WHERE connection_id=$1 AND removed_at IS NULL
        ORDER BY (removed_at IS NULL) DESC,(last_check_status='failed') DESC,name,id`, [connectionId]);
      links = await client.query(`SELECT l.supplier_key_id,l.source_account_id,a.name AS account_name,
        p.enabled AS profit_guard_enabled,p.minimum_margin,p.threshold_mode,p.minimum_sale_multiplier,
        p.allow_empty_groups,p.last_evaluated_at,p.last_action_at,p.last_error
        FROM ${this.schema}.supplier_account_links l
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
        LEFT JOIN ${this.schema}.account_profit_guard_policies p ON p.source_account_id=l.source_account_id
        JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id AND k.removed_at IS NULL
        WHERE k.connection_id=$1`, [connectionId]);
      balances = await client.query(`SELECT balance,currency,observed_at FROM ${this.schema}.supplier_balance_snapshots
        WHERE connection_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 60`, [connectionId]);
      checks = await client.query(`SELECT c.id,c.supplier_key_id,k.name AS key_name,k.masked_key,c.status,c.method,c.http_status,
        c.latency_ms,c.error_code,c.error_message,c.checked_at
        FROM ${this.schema}.supplier_key_checks c JOIN ${this.schema}.supplier_keys k ON k.id=c.supplier_key_id
        WHERE k.connection_id=$1 AND k.removed_at IS NULL AND k.status='active'
        ORDER BY c.checked_at DESC,c.id DESC LIMIT 100`, [connectionId]);
      alerts = await client.query(`SELECT id,supplier_key_id,alert_type,severity,status,title,message,details,first_seen_at,
        last_seen_at,occurrence_count,acknowledged_at,acknowledged_by,resolved_at
        FROM ${this.schema}.supplier_alert_events WHERE connection_id=$1
        ORDER BY (status='open') DESC,last_seen_at DESC,id DESC LIMIT 100`, [connectionId]);
    } finally {
      client.release();
    }
    const linksByKey = new Map();
    for (const row of links.rows) {
      if (!linksByKey.has(String(row.supplier_key_id))) linksByKey.set(String(row.supplier_key_id), []);
      linksByKey.get(String(row.supplier_key_id)).push({
        accountId:Number(row.source_account_id),
        accountName:row.account_name || '',
        profitGuard: row.profit_guard_enabled === null || row.profit_guard_enabled === undefined ? null : {
          enabled: Boolean(row.profit_guard_enabled),
          minimumMargin: Number(row.minimum_margin || 0),
          thresholdMode: row.threshold_mode || 'margin',
          minimumSaleMultiplier: nullableNumber(row.minimum_sale_multiplier),
          allowEmptyGroups: Boolean(row.allow_empty_groups),
          lastEvaluatedAt: row.last_evaluated_at || null,
          lastActionAt: row.last_action_at || null,
          lastError: row.last_error || '',
        },
      });
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
    };
  }

  async listSupplierConnectionAccountCandidates(connectionId, { search = '', limit = 100 } = {}) {
    await this.getSupplierConnection(connectionId);
    const result = await this.pool.query(`
      SELECT a.source_account_id AS id,a.name,a.platform,a.status
      FROM ${this.schema}.dim_accounts a
      WHERE a.source_deleted_at IS NULL
        AND a.status='active'
        AND ($2='' OR a.name ILIKE '%'||$2||'%' OR a.platform ILIKE '%'||$2||'%'
          OR a.source_account_id::text=$2)
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.schema}.supplier_account_links l
          JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
          WHERE l.source_account_id=a.source_account_id
            AND k.connection_id=$1
            AND k.removed_at IS NULL
        )
      ORDER BY a.name,a.source_account_id
      LIMIT $3`, [connectionId, String(search || '').trim(), Math.min(Math.max(Number(limit) || 100, 1), 100)]);
    return {
      items: result.rows.map((row) => ({
        id:Number(row.id),name:row.name,platform:row.platform,status:row.status,
      })),
    };
  }

  async listSupplierGroupSummaries() {
    const result = await this.pool.query(`
      SELECT
        CASE WHEN k.group_id ~ '^[0-9]+$' THEN k.group_id::bigint ELSE NULL END AS source_group_id,
        COUNT(DISTINCT k.id)::int AS key_count,
        COUNT(DISTINCT s.id)::int AS supplier_count,
        ARRAY_AGG(DISTINCT s.name) AS supplier_names,
        COUNT(DISTINCT l.source_account_id)::int AS linked_account_count,
        MIN(k.rate_multiplier) AS minimum_upstream_multiplier,
        MAX(k.rate_multiplier) AS maximum_upstream_multiplier
      FROM ${this.schema}.supplier_keys k
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
      WHERE k.removed_at IS NULL
        AND k.status='active'
        AND k.group_id ~ '^[0-9]+$'
      GROUP BY CASE WHEN k.group_id ~ '^[0-9]+$' THEN k.group_id::bigint ELSE NULL END
    `);
    return result.rows.map((row) => ({
      groupId: Number(row.source_group_id),
      keyCount: Number(row.key_count || 0),
      supplierCount: Number(row.supplier_count || 0),
      supplierNames: Array.isArray(row.supplier_names) ? row.supplier_names.filter(Boolean) : [],
      linkedAccountCount: Number(row.linked_account_count || 0),
      minimumUpstreamMultiplier: nullableNumber(row.minimum_upstream_multiplier),
      maximumUpstreamMultiplier: nullableNumber(row.maximum_upstream_multiplier),
    })).filter((row) => Number.isSafeInteger(row.groupId) && row.groupId > 0);
  }

  async listSupplierGroupKeysForAccounts(accountIds = []) {
    const ids = [...new Set(accountIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    const result = await this.pool.query(`
      SELECT
        l.source_account_id,
        k.id,k.external_key_id,k.name,k.masked_key,k.status,k.group_id,k.group_name,
        k.rate_multiplier,k.last_check_status,k.last_check_at,
        s.name AS supplier_name,c.name AS connection_name,c.base_url,
        COALESCE(NULLIF(gc.platform,''), '') AS platform
      FROM ${this.schema}.supplier_account_links l
      JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      LEFT JOIN ${this.schema}.source_group_catalog gc
        ON gc.source_group_id = CASE
          WHEN k.group_id ~ '^[0-9]+$' THEN k.group_id::bigint
          ELSE NULL
        END
      WHERE l.source_account_id=ANY($1::bigint[])
        AND k.removed_at IS NULL
      ORDER BY l.source_account_id,s.name,c.name,k.name,k.id
    `, [ids]);
    return result.rows.map((row) => ({
      accountId: Number(row.source_account_id),
      id: Number(row.id),
      externalId: row.external_key_id || '',
      name: row.name || '',
      maskedKey: row.masked_key || '',
      status: row.status || '',
      groupId: row.group_id ? Number(row.group_id) : null,
      groupName: row.group_name || '',
      platform: row.platform || '',
      supplierName: row.supplier_name || '',
      connectionName: row.connection_name || '',
      baseUrl: row.base_url || '',
      rateMultiplier: nullableNumber(row.rate_multiplier),
      lastCheckStatus: row.last_check_status || 'pending',
      lastCheckAt: row.last_check_at || null,
    }));
  }

  async listSupplierKeys({
    search = '', supplier = '', platform = '', groupId = '', status = 'active',
    page = 1, pageSize = 20, offset = 0, sortBy = 'last_check_at', sortOrder = 'desc',
  } = {}) {
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const normalizedPlatform = String(platform || '').trim();
    const sortColumns = {
      supplier: 'supplier_name',
      supplier_balance: 'supplier_balance',
      base_url: 'base_url',
      name: 'name',
      platform: 'platform',
      rate_multiplier: 'rate_multiplier',
      profit_range: 'target_margin_min_min',
      minimum_margin: 'minimum_margin_min',
      status: 'status',
      usage_amount: 'usage_amount_cny',
      account_count: 'account_count',
      last_check_at: 'last_check_at',
    };
    const sortColumn = sortColumns[String(sortBy || '')] || sortColumns.last_check_at;
    const direction = String(sortOrder || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const includeUsage = String(sortBy || '') === 'usage_amount';
    const usageCte = includeUsage ? `
      usage_by_account AS (
        SELECT source_account_id,
               COUNT(*)::int AS usage_request_count,
               COALESCE(SUM(
                 COALESCE(input_tokens,0)
                 + COALESCE(output_tokens,0)
                 + COALESCE(cache_creation_tokens,0)
                 + COALESCE(cache_read_tokens,0)
               ),0)::numeric AS usage_token_count,
               COALESCE(SUM(user_charge_cny),0)::numeric AS usage_amount_cny
        FROM ${this.schema}.fact_usage_events
        GROUP BY source_account_id
      ),` : '';
    const usageColumns = includeUsage ? `
               COALESCE(SUM(u.usage_request_count),0)::int AS usage_request_count,
               COALESCE(SUM(u.usage_token_count),0)::numeric AS usage_token_count,
               COALESCE(SUM(u.usage_amount_cny),0)::numeric AS usage_amount_cny,` : `
               0::int AS usage_request_count,
               0::numeric AS usage_token_count,
               0::numeric AS usage_amount_cny,`;
    const usageJoin = includeUsage
      ? `LEFT JOIN usage_by_account u ON u.source_account_id=l.source_account_id`
      : '';
    const result = await this.pool.query(`
      WITH ${usageCte}
      key_rows AS (
        SELECT k.id,k.connection_id,k.external_key_id,k.name,k.masked_key,k.status,k.group_id,k.group_name,
               k.rate_multiplier,k.quota_total,k.quota_used,k.quota_remaining,k.quota_currency,k.expires_at,
               k.last_used_at,k.last_check_status,k.last_check_method,k.last_check_at,k.last_check_error,
               c.name AS connection_name,c.base_url,c.adapter_type,c.detected_adapter_type,
               balance_snapshot.balance AS supplier_balance,
               COALESCE(balance_snapshot.currency,c.balance_currency) AS supplier_balance_currency,
               s.name AS supplier_name,
               COALESCE(NULLIF(gc.platform,''), MAX(NULLIF(a.platform,'')), '') AS platform,
               COUNT(DISTINCT l.source_account_id)::int AS account_count,
               COUNT(DISTINCT l.source_account_id) FILTER (WHERE p.enabled)::int AS profit_guard_account_count,
               ${usageColumns}
               MIN(p.minimum_margin) FILTER (WHERE p.enabled) AS minimum_margin_min,
               MAX(p.minimum_margin) FILTER (WHERE p.enabled) AS minimum_margin_max,
               COUNT(DISTINCT p.minimum_margin) FILTER (WHERE p.enabled)::int AS minimum_margin_variant_count,
               MIN(p.threshold_mode) FILTER (WHERE p.enabled) AS profit_guard_threshold_mode,
               COUNT(DISTINCT p.threshold_mode) FILTER (WHERE p.enabled)::int AS threshold_mode_variant_count,
               MIN(p.target_margin_min) FILTER (WHERE p.auto_assign_enabled) AS target_margin_min_min,
               MAX(p.target_margin_max) FILTER (WHERE p.auto_assign_enabled) AS target_margin_max_max,
               COUNT(DISTINCT (p.target_margin_min,p.target_margin_max))
                 FILTER (WHERE p.auto_assign_enabled)::int AS target_margin_variant_count
        FROM ${this.schema}.supplier_keys k
        JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
        LEFT JOIN ${this.schema}.account_profit_guard_policies p ON p.source_account_id=l.source_account_id
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
        ${usageJoin}
        LEFT JOIN LATERAL (
          SELECT balance,currency
          FROM ${this.schema}.supplier_balance_snapshots
          WHERE connection_id=c.id
          ORDER BY observed_at DESC,id DESC
          LIMIT 1
        ) balance_snapshot ON TRUE
        LEFT JOIN ${this.schema}.source_group_catalog gc
          ON gc.source_group_id = CASE
            WHEN k.group_id ~ '^[0-9]+$' THEN k.group_id::bigint
            ELSE NULL
          END
        WHERE ($1='' OR k.name ILIKE '%'||$1||'%' OR k.masked_key ILIKE '%'||$1||'%'
          OR s.name ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%' OR c.base_url ILIKE '%'||$1||'%')
          AND ($2='' OR s.name=$2)
          AND ($3='' OR ($3='active' AND k.removed_at IS NULL AND k.status='active')
            OR ($3<>'active' AND k.status=$3))
        GROUP BY k.id,c.id,s.id,gc.platform,balance_snapshot.balance,balance_snapshot.currency
      )
      SELECT key_rows.*,COUNT(*) OVER()::int AS total_count
      FROM key_rows
      WHERE ($4='' OR platform=$4)
        AND ($5='' OR group_id=$5)
      ORDER BY ${sortColumn} ${direction} NULLS LAST,id DESC
      LIMIT $6 OFFSET $7`, [search, supplier, normalizedStatus, normalizedPlatform, String(groupId || ''), pageSize, offset]);
    const supplierResult = await this.pool.query(`
      SELECT DISTINCT s.name
      FROM ${this.schema}.supplier_keys k
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      WHERE k.removed_at IS NULL AND k.status='active'
      ORDER BY s.name`);
    const platformResult = await this.pool.query(`
      WITH key_platforms AS (
        SELECT COALESCE(NULLIF(gc.platform,''), MAX(NULLIF(a.platform,'')), '') AS platform
        FROM ${this.schema}.supplier_keys k
        JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        LEFT JOIN ${this.schema}.supplier_account_links l ON l.supplier_key_id=k.id
        LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
        LEFT JOIN ${this.schema}.source_group_catalog gc
          ON gc.source_group_id = CASE
            WHEN k.group_id ~ '^[0-9]+$' THEN k.group_id::bigint
            ELSE NULL
          END
        WHERE k.removed_at IS NULL AND k.status='active'
        GROUP BY k.id,gc.platform
      )
      SELECT DISTINCT platform FROM key_platforms WHERE platform<>'' ORDER BY platform`);
    return {
      ...pageResult(result.rows.map((row) => ({
        id: Number(row.id),
        connectionId: Number(row.connection_id),
        supplierName: row.supplier_name || '',
        connectionName: row.connection_name || '',
        baseUrl: row.base_url || '',
        adapterType: row.detected_adapter_type || row.adapter_type || '',
        platform: row.platform || '',
        supplierBalance: nullableNumber(row.supplier_balance),
        supplierBalanceCurrency: row.supplier_balance_currency || '',
        externalId: row.external_key_id || '',
        name: row.name || '',
        maskedKey: row.masked_key || '',
        status: row.status || '',
        groupId: row.group_id ? Number(row.group_id) : null,
        groupName: row.group_name || '',
        rateMultiplier: nullableNumber(row.rate_multiplier),
        quotaTotal: nullableNumber(row.quota_total),
        quotaUsed: nullableNumber(row.quota_used),
        quotaRemaining: nullableNumber(row.quota_remaining),
        quotaCurrency: row.quota_currency || '',
        expiresAt: row.expires_at || null,
        lastUsedAt: row.last_used_at || null,
        lastCheckStatus: row.last_check_status || 'pending',
        lastCheckMethod: row.last_check_method || '',
        lastCheckAt: row.last_check_at || null,
        lastCheckError: row.last_check_error || '',
        accountCount: Number(row.account_count || 0),
        profitGuardAccountCount: Number(row.profit_guard_account_count || 0),
        usageRequestCount: Number(row.usage_request_count || 0),
        usageTokenCount: Number(row.usage_token_count || 0),
        usageAmountCny: nullableNumber(row.usage_amount_cny) || 0,
        minimumMarginMin: nullableNumber(row.minimum_margin_min),
        minimumMarginMax: nullableNumber(row.minimum_margin_max),
        minimumMarginVariantCount: Number(row.minimum_margin_variant_count || 0),
        profitGuardThresholdMode: row.profit_guard_threshold_mode || null,
        thresholdModeVariantCount: Number(row.threshold_mode_variant_count || 0),
        targetMarginMinMin: nullableNumber(row.target_margin_min_min),
        targetMarginMaxMax: nullableNumber(row.target_margin_max_max),
        targetMarginVariantCount: Number(row.target_margin_variant_count || 0),
      })), page, pageSize),
      suppliers: supplierResult.rows.map((row) => row.name || '').filter(Boolean),
      platforms: platformResult.rows.map((row) => row.platform || '').filter(Boolean),
    };
  }

  async upsertSupplierKeysProfitGuard(keyIds, input, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const keys = await client.query(`
        SELECT id,connection_id FROM ${this.schema}.supplier_keys
        WHERE id=ANY($1::bigint[]) AND removed_at IS NULL`, [keyIds]);
      const foundIds = new Set(keys.rows.map((row) => Number(row.id)));
      const missing = keyIds.filter((id) => !foundIds.has(Number(id)));
      if (missing.length) throw httpError(`supplier keys not found: ${missing.join(',')}`, 404);
      const linked = await client.query(`
        SELECT DISTINCT source_account_id
        FROM ${this.schema}.supplier_account_links
        WHERE supplier_key_id=ANY($1::bigint[])`, [keyIds]);
      const accountIds = linked.rows.map((row) => Number(row.source_account_id));
      if (accountIds.length) {
        await client.query(`
          INSERT INTO ${this.schema}.account_profit_guard_policies(
            source_account_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
            allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
          SELECT unnest($1::bigint[]),$2,$3,$4,$5,$6,$7,$8,$9,$10,$10
          ON CONFLICT(source_account_id) DO UPDATE SET
            enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
            threshold_mode=EXCLUDED.threshold_mode,minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
            allow_empty_groups=EXCLUDED.allow_empty_groups,
            auto_assign_enabled=EXCLUDED.auto_assign_enabled,
            target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
            last_error='',updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [
          accountIds, Boolean(input.enabled), input.minimumMargin, input.thresholdMode,
          input.minimumSaleMultiplier, Boolean(input.allowEmptyGroups), Boolean(input.autoAssignEnabled),
          input.targetMarginMin, input.targetMarginMax, actor,
        ]);
      }
      return {
        keyIds: keyIds.map(Number),
        connectionIds: [...new Set(keys.rows.map((row) => Number(row.connection_id)))],
        accountIds,
        updated: accountIds.length,
      };
    });
  }

  async upsertSupplierKeyProfitGuard(keyId, accountIds, input, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const key = await client.query(`
        SELECT id,connection_id FROM ${this.schema}.supplier_keys
        WHERE id=$1 AND removed_at IS NULL`, [keyId]);
      if (!key.rowCount) throw httpError('supplier key not found', 404);
      const linked = await client.query(`
        SELECT source_account_id FROM ${this.schema}.supplier_account_links
        WHERE supplier_key_id=$1 AND source_account_id=ANY($2::bigint[])`, [keyId, accountIds]);
      const linkedIds = new Set(linked.rows.map((row) => Number(row.source_account_id)));
      const missing = accountIds.filter((id) => !linkedIds.has(Number(id)));
      if (missing.length) throw httpError(`accounts are not linked to this supplier key: ${missing.join(',')}`, 400);
      await client.query(`
        INSERT INTO ${this.schema}.account_profit_guard_policies(
          source_account_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
          allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
        SELECT unnest($1::bigint[]),$2,$3,$4,$5,$6,$7,$8,$9,$10,$10
        ON CONFLICT(source_account_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
          threshold_mode=EXCLUDED.threshold_mode,minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
          allow_empty_groups=EXCLUDED.allow_empty_groups,
          auto_assign_enabled=EXCLUDED.auto_assign_enabled,
          target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
          last_error='',updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [
        accountIds, Boolean(input.enabled), input.minimumMargin, input.thresholdMode,
        input.minimumSaleMultiplier, Boolean(input.allowEmptyGroups), Boolean(input.autoAssignEnabled),
        input.targetMarginMin, input.targetMarginMax, actor,
      ]);
      return {
        keyId: Number(keyId),
        connectionId: Number(key.rows[0].connection_id),
        accountIds: accountIds.map(Number),
        updated: accountIds.length,
      };
    });
  }

  async getSupplierKeyDetails(keyId) {
    const keyResult = await this.pool.query(`
      SELECT k.id,k.connection_id,k.external_key_id,k.name,k.masked_key,k.status,k.group_id,k.group_name,
             k.rate_multiplier,k.quota_total,k.quota_used,k.quota_remaining,k.quota_currency,k.expires_at,
             k.last_used_at,k.last_check_status,k.last_check_method,k.last_check_at,k.last_check_error,
             k.first_seen_at,k.last_seen_at,k.removed_at,
             c.name AS connection_name,c.base_url,c.adapter_type,c.detected_adapter_type,
             s.name AS supplier_name,s.notes AS supplier_notes
      FROM ${this.schema}.supplier_keys k
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      WHERE k.id=$1`, [keyId]);
    if (!keyResult.rowCount) throw httpError('supplier key not found', 404);
    const row = keyResult.rows[0];
    const linksResult = await this.pool.query(`
      SELECT l.source_account_id,a.name AS account_name,a.platform,a.status,
             p.enabled,p.minimum_margin,p.threshold_mode,p.minimum_sale_multiplier,
             p.allow_empty_groups,p.auto_assign_enabled,p.target_margin_min,p.target_margin_max,
             p.last_evaluated_at,p.last_action_at,p.last_error
      FROM ${this.schema}.supplier_account_links l
      LEFT JOIN ${this.schema}.dim_accounts a ON a.source_account_id=l.source_account_id
      LEFT JOIN ${this.schema}.account_profit_guard_policies p ON p.source_account_id=l.source_account_id
      WHERE l.supplier_key_id=$1 ORDER BY a.name,l.source_account_id`, [keyId]);
    const [checks, alerts] = await Promise.all([
      this.pool.query(`
        SELECT id,status,method,http_status,latency_ms,error_code,error_message,checked_at
        FROM ${this.schema}.supplier_key_checks WHERE supplier_key_id=$1
        ORDER BY checked_at DESC,id DESC LIMIT 50`, [keyId]),
      this.pool.query(`
        SELECT id,alert_type,severity,status,title,message,details,last_seen_at,occurrence_count
        FROM ${this.schema}.supplier_alert_events WHERE supplier_key_id=$1
        ORDER BY last_seen_at DESC,id DESC LIMIT 50`, [keyId]),
    ]);
    return {
      key: {
        id: Number(row.id), connectionId: Number(row.connection_id), supplierName: row.supplier_name || '',
        supplierNotes: row.supplier_notes || '', connectionName: row.connection_name || '',
        baseUrl: row.base_url || '', adapterType: row.detected_adapter_type || row.adapter_type || '',
        externalId: row.external_key_id || '', name: row.name || '', maskedKey: row.masked_key || '',
        status: row.status || '', groupId: row.group_id ? Number(row.group_id) : null,
        groupName: row.group_name || '', rateMultiplier: nullableNumber(row.rate_multiplier),
        quotaTotal: nullableNumber(row.quota_total), quotaUsed: nullableNumber(row.quota_used),
        quotaRemaining: nullableNumber(row.quota_remaining), quotaCurrency: row.quota_currency || '',
        expiresAt: row.expires_at || null, lastUsedAt: row.last_used_at || null,
        lastCheckStatus: row.last_check_status || 'pending', lastCheckMethod: row.last_check_method || '',
        lastCheckAt: row.last_check_at || null, lastCheckError: row.last_check_error || '',
        firstSeenAt: row.first_seen_at || null, lastSeenAt: row.last_seen_at || null, removedAt: row.removed_at || null,
      },
      accounts: linksResult.rows.map((link) => ({
        id: Number(link.source_account_id), name: link.account_name || '', platform: link.platform || '',
        status: link.status || '',
        profitGuard: link.enabled === null || link.enabled === undefined ? null : {
          enabled: Boolean(link.enabled), minimumMargin: Number(link.minimum_margin || 0),
          thresholdMode: link.threshold_mode || 'margin',
          minimumSaleMultiplier: nullableNumber(link.minimum_sale_multiplier),
          allowEmptyGroups: Boolean(link.allow_empty_groups), autoAssignEnabled: Boolean(link.auto_assign_enabled),
          targetMarginMin: nullableNumber(link.target_margin_min), targetMarginMax: nullableNumber(link.target_margin_max),
          lastEvaluatedAt: link.last_evaluated_at || null, lastActionAt: link.last_action_at || null,
          lastError: link.last_error || '',
        },
      })),
      checks: checks.rows.map((check) => ({
        id: Number(check.id), status: check.status || '', method: check.method || '',
        httpStatus: check.http_status ? Number(check.http_status) : null, latencyMs: nullableNumber(check.latency_ms),
        errorCode: check.error_code || '', errorMessage: check.error_message || '', checkedAt: check.checked_at || null,
      })),
      alerts: alerts.rows.map((alert) => ({
        id: Number(alert.id), type: alert.alert_type || '', severity: alert.severity || '',
        status: alert.status || '', title: alert.title || '', message: alert.message || '',
        details: alert.details || {}, lastSeenAt: alert.last_seen_at || null, occurrenceCount: Number(alert.occurrence_count || 0),
      })),
    };
  }

  async setSupplierKeyAccountLink(keyId, accountId, linked, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const keyResult = await client.query(`
        SELECT k.id,k.connection_id,k.external_key_id,k.name,k.masked_key,k.group_name,k.status,k.removed_at,
               k.last_check_status,k.last_check_at,c.adapter_type,c.detected_adapter_type,
               c.enabled,s.name AS supplier_name
        FROM ${this.schema}.supplier_keys k
        JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE k.id=$1
        FOR UPDATE OF k`, [keyId]);
      if (!keyResult.rowCount) throw httpError('supplier key not found', 404);
      const key = keyResult.rows[0];
      const account = await client.query(`SELECT source_account_id FROM ${this.schema}.dim_accounts WHERE source_account_id=$1`, [accountId]);
      if (!account.rowCount) throw httpError('account not found', 404);
      const previousLink = await client.query(`
        SELECT supplier_key_id
        FROM ${this.schema}.supplier_account_links
        WHERE source_account_id=$1
        FOR UPDATE`, [accountId]);
      const previousKeyId = previousLink.rowCount ? Number(previousLink.rows[0].supplier_key_id) : null;
      let rule = null;
      if (linked) {
        const adapterType = key.detected_adapter_type || key.adapter_type;
        if (!['sub2api','newapi'].includes(adapterType)) {
          throw httpError('only Sub2API or NewAPI supplier keys can drive automatic account multipliers', 409);
        }
        if (!key.enabled || key.removed_at || key.status !== 'active') {
          throw httpError('the supplier key is not currently active', 409);
        }
        const fixedCosts = await client.query(`
          SELECT 1
          FROM ${this.schema}.account_cost_periods
          WHERE source_account_id=$1 AND status='active' AND effective_to>NOW()
          LIMIT 1`, [accountId]);
        if (fixedCosts.rowCount) {
          throw httpError('end the active fixed-cost period before linking a supplier key to avoid double-counting', 409);
        }
        if (previousKeyId && previousKeyId !== Number(keyId)) {
          await client.query(`
            UPDATE ${this.schema}.account_rate_observations
            SET fresh_until=LEAST(COALESCE(fresh_until,NOW()),NOW())
            WHERE source_account_id=$1 AND supplier_key_id=$2 AND fresh_until>NOW()`,
          [accountId,previousKeyId]);
        }
        await client.query(`
          INSERT INTO ${this.schema}.supplier_account_links(supplier_key_id,source_account_id,created_by)
          VALUES($1,$2,$3)
          ON CONFLICT(source_account_id) DO UPDATE SET
            supplier_key_id=EXCLUDED.supplier_key_id,
            created_by=EXCLUDED.created_by,
            created_at=NOW()`, [keyId,accountId,actor]);
        rule = await this.upsertAccountCostRule(client, accountId, {
          costProfileId: null,
          costMode: 'probe_multiplier',
          basisMode: 'revenue_backsolve',
          upstreamMultiplier: null,
          cnyPerReferenceUnit: null,
          changeStrategy: 'future_only',
          strictFutureOnly: true,
          supplierKeyId: Number(keyId),
          notes: '',
        }, null, actor);
        await client.query(`
          UPDATE ${this.schema}.dim_accounts
          SET cost_profile_id=NULL,supplier=$2,purchase_batch=$3,synced_at=NOW()
          WHERE source_account_id=$1`,
        [accountId,key.supplier_name,supplierKeyPurchaseBatch(key)]);
        const defaultPolicy = await client.query(`
          SELECT enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,allow_empty_groups,
                 auto_assign_enabled,target_margin_min,target_margin_max
          FROM ${this.schema}.supplier_profit_guard_defaults
          WHERE connection_id=$1`, [key.connection_id]);
        if (defaultPolicy.rowCount) {
          const policy = defaultPolicy.rows[0];
          await client.query(`
            INSERT INTO ${this.schema}.account_profit_guard_policies(
              source_account_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
              allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
            ON CONFLICT(source_account_id) DO UPDATE SET
              enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
              threshold_mode=EXCLUDED.threshold_mode,
              minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
              allow_empty_groups=EXCLUDED.allow_empty_groups,last_error='',
              auto_assign_enabled=EXCLUDED.auto_assign_enabled,
              target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
              updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
          [
            accountId, Boolean(policy.enabled), policy.minimum_margin, policy.threshold_mode,
            policy.minimum_sale_multiplier, Boolean(policy.allow_empty_groups),
            Boolean(policy.auto_assign_enabled), policy.target_margin_min, policy.target_margin_max, actor,
          ]);
        }
      } else {
        await client.query(`
          DELETE FROM ${this.schema}.supplier_account_links
          WHERE supplier_key_id=$1 AND source_account_id=$2`, [keyId,accountId]);
        await client.query(`
          UPDATE ${this.schema}.account_rate_observations
          SET fresh_until=LEAST(COALESCE(fresh_until,NOW()),NOW())
          WHERE source_account_id=$1 AND supplier_key_id=$2 AND fresh_until>NOW()`,
        [accountId,keyId]);
        await client.query(`
          UPDATE ${this.schema}.account_cost_rules
          SET effective_to=NOW(),status='superseded',updated_at=NOW()
          WHERE source_account_id=$1 AND supplier_key_id=$2
            AND status='active' AND effective_to IS NULL`, [accountId,keyId]);
        await client.query(`
          UPDATE ${this.schema}.dim_accounts
          SET supplier=CASE WHEN supplier=$2 THEN '' ELSE supplier END,
              purchase_batch=CASE WHEN purchase_batch=$3 THEN '' ELSE purchase_batch END,
              synced_at=NOW()
          WHERE source_account_id=$1`,
        [accountId,key.supplier_name,supplierKeyPurchaseBatch(key)]);
      }
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_supplier_account_link','supplier_key',$2,$3::jsonb)`,
      [actor,String(keyId),JSON.stringify({
        sourceAccountId:accountId,linked,previousSupplierKeyId:previousKeyId,
        connectionId:Number(key.connection_id),costRuleId:rule?.id ? Number(rule.id) : null,
      })]);
      return {
        keyId:Number(keyId),
        accountId:Number(accountId),
        linked:Boolean(linked),
        connectionId:Number(key.connection_id),
        supplierName:key.supplier_name,
        keyName:key.name || key.masked_key || '',
        costMode:linked ? 'probe_multiplier' : '',
        probeStatus:key.last_check_status || 'pending',
        probeCheckedAt:key.last_check_at || null,
        adapterType:key.detected_adapter_type || key.adapter_type,
      };
    });
  }

  async getSupplierProfitGuardDefault(connectionId) {
    await this.getSupplierConnection(connectionId);
    const result = await this.pool.query(`
      SELECT connection_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
             allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,updated_by,updated_at
      FROM ${this.schema}.supplier_profit_guard_defaults
      WHERE connection_id=$1`, [connectionId]);
    const row = result.rows[0];
    return {
      connectionId:Number(connectionId),
      configured:Boolean(row),
      enabled:Boolean(row?.enabled),
      minimumMargin:Number(row?.minimum_margin || 0),
      thresholdMode:row?.threshold_mode || 'margin',
      minimumSaleMultiplier:nullableNumber(row?.minimum_sale_multiplier),
      allowEmptyGroups:row?.allow_empty_groups === undefined ? true : Boolean(row.allow_empty_groups),
      autoAssignEnabled:Boolean(row?.auto_assign_enabled),
      targetMarginMin:nullableNumber(row?.target_margin_min),
      targetMarginMax:nullableNumber(row?.target_margin_max),
      updatedBy:row?.updated_by || '',
      updatedAt:row?.updated_at || null,
    };
  }

  async upsertSupplierProfitGuardDefault(connectionId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const connection = await client.query(`
        SELECT id FROM ${this.schema}.supplier_connections WHERE id=$1 FOR UPDATE`, [connectionId]);
      if (!connection.rowCount) throw httpError('supplier connection not found', 404);
      const policyResult = await client.query(`
        INSERT INTO ${this.schema}.supplier_profit_guard_defaults(
          connection_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
          allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT(connection_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
          threshold_mode=EXCLUDED.threshold_mode,
          minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
          allow_empty_groups=EXCLUDED.allow_empty_groups,
          auto_assign_enabled=EXCLUDED.auto_assign_enabled,
          target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
          updated_by=EXCLUDED.updated_by,updated_at=NOW()
        RETURNING connection_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
                  allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,updated_by,updated_at`,
      [
        connectionId, Boolean(input.enabled), input.minimumMargin, input.thresholdMode,
        input.minimumSaleMultiplier, Boolean(input.allowEmptyGroups), Boolean(input.autoAssignEnabled),
        input.targetMarginMin, input.targetMarginMax, actor,
      ]);
      const applied = await client.query(`
        INSERT INTO ${this.schema}.account_profit_guard_policies(
          source_account_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
          allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
        SELECT l.source_account_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10
        FROM ${this.schema}.supplier_account_links l
        JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
        WHERE k.connection_id=$1
        ON CONFLICT(source_account_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
          threshold_mode=EXCLUDED.threshold_mode,
          minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
          allow_empty_groups=EXCLUDED.allow_empty_groups,last_error='',
          auto_assign_enabled=EXCLUDED.auto_assign_enabled,
          target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
          updated_by=EXCLUDED.updated_by,updated_at=NOW()
        RETURNING source_account_id`,
      [
        connectionId, Boolean(input.enabled), input.minimumMargin, input.thresholdMode,
        input.minimumSaleMultiplier, Boolean(input.allowEmptyGroups), Boolean(input.autoAssignEnabled),
        input.targetMarginMin, input.targetMarginMax, actor,
      ]);
      const row = policyResult.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'upsert_supplier_profit_guard_default','supplier_connection',$2,$3::jsonb)`,
      [actor,String(connectionId),JSON.stringify({
        enabled:Boolean(row.enabled),
        minimumMargin:Number(row.minimum_margin || 0),
        thresholdMode:row.threshold_mode,
        minimumSaleMultiplier:nullableNumber(row.minimum_sale_multiplier),
        allowEmptyGroups:Boolean(row.allow_empty_groups),
        autoAssignEnabled:Boolean(row.auto_assign_enabled),
        targetMarginMin:nullableNumber(row.target_margin_min),
        targetMarginMax:nullableNumber(row.target_margin_max),
        appliedAccountCount:applied.rowCount,
      })]);
      return {
        connectionId:Number(row.connection_id),
        configured:true,
        enabled:Boolean(row.enabled),
        minimumMargin:Number(row.minimum_margin || 0),
        thresholdMode:row.threshold_mode || 'margin',
        minimumSaleMultiplier:nullableNumber(row.minimum_sale_multiplier),
        allowEmptyGroups:Boolean(row.allow_empty_groups),
        updatedBy:row.updated_by || '',
        updatedAt:row.updated_at || null,
        appliedAccountCount:applied.rowCount,
      };
    });
  }

  async listProfitGuardCandidates(connectionId) {
    const result = await this.pool.query(`
      SELECT p.source_account_id,a.name AS account_name,a.platform,
             l.supplier_key_id,k.name AS key_name,k.masked_key,
             c.id AS connection_id,c.name AS connection_name,s.name AS supplier_name,
             COALESCE(ob.effective_rate_multiplier,ob.resolved_rate_multiplier,k.rate_multiplier) AS upstream_multiplier,
             ob.observed_at AS multiplier_observed_at,
             p.minimum_margin,p.threshold_mode,p.minimum_sale_multiplier,p.allow_empty_groups,
             p.auto_assign_enabled,p.target_margin_min,p.target_margin_max
      FROM ${this.schema}.account_profit_guard_policies p
      JOIN ${this.schema}.supplier_account_links l ON l.source_account_id=p.source_account_id
      JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
      JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
      JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
      JOIN ${this.schema}.dim_accounts a ON a.source_account_id=p.source_account_id
      LEFT JOIN LATERAL (
        SELECT o.effective_rate_multiplier,o.resolved_rate_multiplier,o.observed_at
        FROM ${this.schema}.account_rate_observations o
        WHERE o.source_account_id=p.source_account_id AND o.supplier_key_id=k.id
          AND (o.fresh_until IS NULL OR o.fresh_until > NOW())
        ORDER BY COALESCE(o.observed_at,o.received_at,o.last_attempt_at,o.captured_at) DESC,o.id DESC
        LIMIT 1
      ) ob ON TRUE
      WHERE p.enabled AND c.id=$1 AND c.enabled
        AND k.removed_at IS NULL AND k.status='active'
        AND a.source_deleted_at IS NULL
      ORDER BY p.source_account_id`, [connectionId]);
    return result.rows.map((row) => ({
      accountId: Number(row.source_account_id),
      accountName: row.account_name || '',
      platform: row.platform || '',
      supplierKeyId: Number(row.supplier_key_id),
      supplierKeyName: row.key_name || row.masked_key || '',
      connectionId: Number(row.connection_id),
      connectionName: row.connection_name || '',
      supplierName: row.supplier_name || '',
      upstreamMultiplier: nullableNumber(row.upstream_multiplier),
      multiplierObservedAt: row.multiplier_observed_at || null,
      minimumMargin: Number(row.minimum_margin || 0),
      thresholdMode: row.threshold_mode || 'margin',
      minimumSaleMultiplier: nullableNumber(row.minimum_sale_multiplier),
      allowEmptyGroups: Boolean(row.allow_empty_groups),
      autoAssignEnabled: Boolean(row.auto_assign_enabled),
      targetMarginMin: nullableNumber(row.target_margin_min),
      targetMarginMax: nullableNumber(row.target_margin_max),
    }));
  }

  async getAccountProfitGuard(accountId) {
    const [policyResult, eventsResult] = await Promise.all([
      this.pool.query(`
        SELECT p.*,l.supplier_key_id,k.name AS key_name,k.masked_key,k.rate_multiplier,
               k.removed_at,k.status AS key_status,s.name AS supplier_name,c.name AS connection_name
        FROM ${this.schema}.account_profit_guard_policies p
        LEFT JOIN ${this.schema}.supplier_account_links l ON l.source_account_id=p.source_account_id
        LEFT JOIN ${this.schema}.supplier_keys k ON k.id=l.supplier_key_id
        LEFT JOIN ${this.schema}.supplier_connections c ON c.id=k.connection_id
        LEFT JOIN ${this.schema}.suppliers s ON s.id=c.supplier_id
        WHERE p.source_account_id=$1`, [accountId]),
      this.pool.query(`
        SELECT id,supplier_key_id,source_group_id,action,upstream_multiplier,
               group_multiplier,minimum_margin,threshold_mode,minimum_sale_multiplier,
               before_group_ids,after_group_ids,reason,applied_at
        FROM ${this.schema}.account_profit_guard_events
        WHERE source_account_id=$1 ORDER BY applied_at DESC,id DESC LIMIT 50`, [accountId]),
    ]);
    const row = policyResult.rows[0] || null;
    return {
      accountId: Number(accountId),
      policy: row ? {
        enabled: Boolean(row.enabled),
        minimumMargin: Number(row.minimum_margin || 0),
        thresholdMode: row.threshold_mode || 'margin',
        minimumSaleMultiplier: nullableNumber(row.minimum_sale_multiplier),
        allowEmptyGroups: Boolean(row.allow_empty_groups),
        autoAssignEnabled: Boolean(row.auto_assign_enabled),
        targetMarginMin: nullableNumber(row.target_margin_min),
        targetMarginMax: nullableNumber(row.target_margin_max),
        lastEvaluatedAt: row.last_evaluated_at || null,
        lastActionAt: row.last_action_at || null,
        lastError: row.last_error || '',
      } : {
        enabled: false, minimumMargin: 0, thresholdMode: 'margin', minimumSaleMultiplier: null, allowEmptyGroups: true,
        autoAssignEnabled: false, targetMarginMin: null, targetMarginMax: null,
        lastEvaluatedAt: null, lastActionAt: null, lastError: '',
      },
      supplier: row && row.supplier_key_id ? {
        keyId: Number(row.supplier_key_id),
        keyName: row.key_name || row.masked_key || '',
        supplierName: row.supplier_name || '',
        connectionName: row.connection_name || '',
        upstreamMultiplier: nullableNumber(row.rate_multiplier),
        removed: Boolean(row.removed_at) || row.key_status !== 'active',
      } : null,
      events: eventsResult.rows.map((event) => ({
        id: Number(event.id),
        supplierKeyId: event.supplier_key_id ? Number(event.supplier_key_id) : null,
        groupId: Number(event.source_group_id),
        action: event.action,
        upstreamMultiplier: nullableNumber(event.upstream_multiplier),
        groupMultiplier: nullableNumber(event.group_multiplier),
        minimumMargin: nullableNumber(event.minimum_margin),
        thresholdMode: event.threshold_mode || 'margin',
        minimumSaleMultiplier: nullableNumber(event.minimum_sale_multiplier),
        beforeGroupIds: event.before_group_ids || [],
        afterGroupIds: event.after_group_ids || [],
        reason: event.reason || '',
        appliedAt: event.applied_at,
      })),
    };
  }

  async upsertAccountProfitGuard(accountId, input, actor='admin') {
    return inTransaction(this.pool, async (client) => {
      const account = await client.query(`
        SELECT source_account_id FROM ${this.schema}.dim_accounts
        WHERE source_account_id=$1 AND source_deleted_at IS NULL`, [accountId]);
      if (!account.rowCount) throw httpError('account not found', 404);
      const result = await client.query(`
        INSERT INTO ${this.schema}.account_profit_guard_policies(
          source_account_id,enabled,minimum_margin,threshold_mode,minimum_sale_multiplier,
          allow_empty_groups,auto_assign_enabled,target_margin_min,target_margin_max,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
        ON CONFLICT(source_account_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,minimum_margin=EXCLUDED.minimum_margin,
          threshold_mode=EXCLUDED.threshold_mode,minimum_sale_multiplier=EXCLUDED.minimum_sale_multiplier,
          allow_empty_groups=EXCLUDED.allow_empty_groups,
          auto_assign_enabled=EXCLUDED.auto_assign_enabled,
          target_margin_min=EXCLUDED.target_margin_min,target_margin_max=EXCLUDED.target_margin_max,
          updated_by=EXCLUDED.updated_by,
          updated_at=NOW()
        RETURNING *`, [
        accountId, Boolean(input.enabled), input.minimumMargin, input.thresholdMode,
        input.minimumSaleMultiplier, Boolean(input.allowEmptyGroups), Boolean(input.autoAssignEnabled),
        input.targetMarginMin, input.targetMarginMax, actor,
      ]);
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update','account_profit_guard_policy',$2,$3::jsonb)`,
      [actor, String(accountId), JSON.stringify(input)]);
      const row = result.rows[0];
      return {
        accountId: Number(row.source_account_id),
        enabled: Boolean(row.enabled),
        minimumMargin: Number(row.minimum_margin),
        thresholdMode: row.threshold_mode || 'margin',
        minimumSaleMultiplier: nullableNumber(row.minimum_sale_multiplier),
        allowEmptyGroups: Boolean(row.allow_empty_groups),
        autoAssignEnabled: Boolean(row.auto_assign_enabled),
        targetMarginMin: nullableNumber(row.target_margin_min),
        targetMarginMax: nullableNumber(row.target_margin_max),
        lastEvaluatedAt: row.last_evaluated_at || null,
        lastActionAt: row.last_action_at || null,
        lastError: row.last_error || '',
      };
    });
  }

  async recordProfitGuardEvaluation(candidate, details = {}) {
    return inTransaction(this.pool, async (client) => {
      await client.query(`
        UPDATE ${this.schema}.account_profit_guard_policies
        SET last_evaluated_at=NOW(),last_error='',updated_at=NOW()
        WHERE source_account_id=$1`, [candidate.accountId]);
      if (!details.action) return;
      const beforeIds = details.beforeGroupIds || [];
      const afterIds = details.afterGroupIds || [];
      await client.query(`
        INSERT INTO ${this.schema}.account_profit_guard_events(
          source_account_id,supplier_key_id,source_group_id,action,upstream_multiplier,
          group_multiplier,minimum_margin,threshold_mode,minimum_sale_multiplier,
          before_group_ids,after_group_ids,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`, [
        candidate.accountId,candidate.supplierKeyId,details.groupId,details.action,
        details.upstreamMultiplier,details.groupMultiplier,candidate.minimumMargin,
        candidate.thresholdMode,candidate.minimumSaleMultiplier,
        JSON.stringify(beforeIds),JSON.stringify(afterIds),details.reason,
      ]);
      await client.query(`
        UPDATE ${this.schema}.account_profit_guard_policies
        SET last_action_at=NOW(),updated_at=NOW()
        WHERE source_account_id=$1`, [candidate.accountId]);
      const alertCopy = profitGuardAlertCopy({
        action: details.action,
        groupName: details.groupName,
        groupId: details.groupId,
        accountName: candidate.accountName,
        accountId: candidate.accountId,
        reason: details.reason,
      });
      await client.query(`
        INSERT INTO ${this.schema}.supplier_alert_events(
          connection_id,supplier_key_id,dedupe_key,alert_type,severity,title,message,details)
        SELECT c.id,$2,$3,'account_profit_guard','critical',$4,$5,$6::jsonb
        FROM ${this.schema}.supplier_connections c
        WHERE c.id=$1 AND c.alert_enabled
        ON CONFLICT(connection_id,dedupe_key) DO UPDATE SET
          supplier_key_id=EXCLUDED.supplier_key_id,status='open',severity='critical',
          title=EXCLUDED.title,message=EXCLUDED.message,details=EXCLUDED.details,
          last_seen_at=NOW(),occurrence_count=supplier_alert_events.occurrence_count+1,
          resolved_at=NULL`, [
        candidate.connectionId,candidate.supplierKeyId,
        `profit-guard:${candidate.accountId}:${details.groupId}:${details.action}`,
        alertCopy.title,
        alertCopy.message,
        JSON.stringify({
          accountId: candidate.accountId, accountName: candidate.accountName,
          supplierKeyId: candidate.supplierKeyId, supplier: candidate.supplierName,
          upstreamMultiplier: details.upstreamMultiplier, groupId: details.groupId,
          groupName: details.groupName || '', groupMultiplier: details.groupMultiplier,
          minimumMargin: candidate.minimumMargin, beforeGroupIds: beforeIds, afterGroupIds: afterIds,
          action: details.action,
        }),
      ]);
    });
  }

  async recordProfitGuardError(accountId, message) {
    await this.pool.query(`
      UPDATE ${this.schema}.account_profit_guard_policies
      SET last_evaluated_at=NOW(),last_error=$2,updated_at=NOW()
      WHERE source_account_id=$1`, [accountId, String(message || '').slice(0, 1000)]);
  }

  async getSub2ApiServiceAuthSettings({ includeCiphertext = false } = {}) {
    const result = await this.pool.query(`
      SELECT enabled,auth_mode,email,credentials_ciphertext,last_authenticated_at,token_expires_at,
             last_error,updated_by,updated_at
      FROM ${this.schema}.sub2api_service_auth_settings WHERE id=1`);
    return sub2ApiServiceAuthSettings(result.rows[0], { includeCiphertext });
  }

  async updateSub2ApiServiceAuthSettings(input, credentialsCiphertext, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE ${this.schema}.sub2api_service_auth_settings SET
          enabled=$1,auth_mode=$2,email=$3,credentials_ciphertext=$4,last_error='',
          last_authenticated_at=NULL,token_expires_at=NULL,updated_by=$5,updated_at=NOW()
        WHERE id=1
        RETURNING enabled,auth_mode,email,credentials_ciphertext,last_authenticated_at,token_expires_at,
                  last_error,updated_by,updated_at`,
      [Boolean(input.enabled), input.authMode || 'password', input.email || '', credentialsCiphertext || '', actor]);
      const row = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_sub2api_service_auth','sub2api_service_auth_settings','singleton',$2::jsonb)`,
      [actor, JSON.stringify({
        enabled: Boolean(row.enabled),
        authMode: row.auth_mode || 'password',
        email: row.email || '',
        credentialsConfigured: Boolean(row.credentials_ciphertext),
      })]);
      return sub2ApiServiceAuthSettings(row);
    });
  }

  async recordSub2ApiServiceAuthResult({ lastAuthenticatedAt = null, tokenExpiresAt = null, lastError = '' }) {
    await this.pool.query(`
      UPDATE ${this.schema}.sub2api_service_auth_settings SET
        last_authenticated_at=COALESCE($1::timestamptz,last_authenticated_at),
        token_expires_at=CASE WHEN $1::timestamptz IS NULL THEN NULL ELSE $2::timestamptz END,
        last_error=$3,updated_at=NOW()
      WHERE id=1`,
    [lastAuthenticatedAt, tokenExpiresAt, String(lastError || '').slice(0, 1000)]);
  }

  async getOAuthSupplyAuthSettings({ includeCiphertext = false } = {}) {
    const result = await this.pool.query(`
      SELECT enabled,base_url,username,credentials_ciphertext,token_ciphertext,
             last_authenticated_at,token_expires_at,last_error,updated_by,updated_at
      FROM ${this.schema}.oauth_supply_auth_settings WHERE id=1`);
    return oauthSupplyAuthSettings(result.rows[0], { includeCiphertext });
  }

  async updateOAuthSupplyAuthSettings(input, credentialsCiphertext, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE ${this.schema}.oauth_supply_auth_settings SET
          enabled=$1,base_url=$2,username=$3,credentials_ciphertext=$4,
          token_ciphertext='',last_authenticated_at=NULL,token_expires_at=NULL,
          last_error='',updated_by=$5,updated_at=NOW()
        WHERE id=1
        RETURNING enabled,base_url,username,credentials_ciphertext,token_ciphertext,
                  last_authenticated_at,token_expires_at,last_error,updated_by,updated_at`,
      [Boolean(input.enabled), input.baseUrl, input.username || '', credentialsCiphertext || '', actor]);
      const row = result.rows[0];
      await client.query(`INSERT INTO ${this.schema}.audit_logs(actor,action,object_type,object_id,after_value)
        VALUES($1,'update_oauth_supply_auth','oauth_supply_auth_settings','singleton',$2::jsonb)`,
      [actor, JSON.stringify({
        enabled: Boolean(row.enabled),
        baseUrl: row.base_url,
        username: row.username,
        credentialsConfigured: Boolean(row.credentials_ciphertext),
      })]);
      return oauthSupplyAuthSettings(row);
    });
  }

  async recordOAuthSupplyAuthResult({
    tokenCiphertext = null, lastAuthenticatedAt = null, tokenExpiresAt = null, lastError = '',
  }) {
    await this.pool.query(`
      UPDATE ${this.schema}.oauth_supply_auth_settings SET
        token_ciphertext=CASE WHEN $1::text IS NULL THEN token_ciphertext ELSE $1 END,
        token_expires_at=CASE WHEN $1::text IS NULL THEN token_expires_at ELSE $2::timestamptz END,
        last_authenticated_at=COALESCE($3::timestamptz,last_authenticated_at),
        last_error=$4,updated_at=NOW()
      WHERE id=1`,
    [tokenCiphertext, tokenExpiresAt, lastAuthenticatedAt, String(lastError || '').slice(0, 1000)]);
  }

  async acknowledgeSupplierAlert(alertId, actor='admin') {
    const result = await this.pool.query(`UPDATE ${this.schema}.supplier_alert_events
      SET status='acknowledged',acknowledged_at=NOW(),acknowledged_by=$2,last_seen_at=NOW()
      WHERE id=$1 RETURNING id,status,acknowledged_at,acknowledged_by`, [alertId,actor]);
    if (!result.rowCount) throw httpError('supplier alert not found', 404);
    return { id:Number(result.rows[0].id),status:result.rows[0].status,acknowledgedAt:result.rows[0].acknowledged_at,acknowledgedBy:result.rows[0].acknowledged_by };
  }

  async getRuntimeDashboard(liveRuntime = null) {
    if (liveRuntime) {
      const userIds = (liveRuntime.users || []).map((item) => Number(item.sourceUserId)).filter(Boolean);
      const accountIds = (liveRuntime.accounts || []).map((item) => Number(item.sourceAccountId)).filter(Boolean);
      const [usersResult, accountsResult] = await Promise.all([
        userIds.length ? this.pool.query(`
          SELECT source_user_id,email,username
          FROM ${this.schema}.dim_users
          WHERE source_user_id=ANY($1::bigint[])`, [userIds]) : { rows: [] },
        accountIds.length ? this.pool.query(`
          SELECT source_account_id,name,platform
          FROM ${this.schema}.dim_accounts
          WHERE source_account_id=ANY($1::bigint[])`, [accountIds]) : { rows: [] },
      ]);
      const userDetails = new Map(usersResult.rows.map((row) => [Number(row.source_user_id), row]));
      const accountDetails = new Map(accountsResult.rows.map((row) => [Number(row.source_account_id), row]));
      const observedAt = liveRuntime.observedAt || new Date();
      return {
        queue: liveRuntime.queue ? {
          available: true,
          ...liveRuntime.queue,
          observedAt,
        } : { available: false },
        users: (liveRuntime.users || []).map((item) => {
          const id = Number(item.sourceUserId);
          const detail = userDetails.get(id) || {};
          const maxConcurrency = number(item.maxConcurrency);
          const currentConcurrency = number(item.currentConcurrency);
          return {
            id,
            email: item.email || detail.email || '',
            username: item.username || detail.username || '',
            maxConcurrency,
            currentConcurrency,
            waitingCount: number(item.waitingCount),
            usagePercent: maxConcurrency > 0 ? Math.min(100, currentConcurrency * 100 / maxConcurrency) : null,
            observedAt,
          };
        }).sort((a,b) => b.waitingCount-a.waitingCount || b.currentConcurrency-a.currentConcurrency),
        accounts: (liveRuntime.accounts || []).map((item) => {
          const id = Number(item.sourceAccountId);
          const detail = accountDetails.get(id) || {};
          return {
            id,
            name: detail.name || `Account #${id}`,
            platform: detail.platform || '',
            currentConcurrency: number(item.currentConcurrency),
            waitingCount: number(item.waitingCount),
            observedAt,
          };
        }).sort((a,b) => b.waitingCount-a.waitingCount || b.currentConcurrency-a.currentConcurrency),
      };
    }
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
