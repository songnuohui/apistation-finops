import Decimal from 'decimal.js/decimal.mjs';
import { inTransaction } from '../db.mjs';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const USAGE_COLUMNS = [
  'source_usage_id', 'request_id', 'source_user_id', 'source_api_key_id', 'source_account_id',
  'source_group_id', 'source_channel_id', 'model', 'requested_model', 'upstream_model',
  'billing_mode', 'billing_type', 'subscription_id', 'input_tokens', 'output_tokens',
  'cache_creation_tokens', 'cache_read_tokens', 'user_rate_multiplier', 'account_rate_multiplier', 'duration_ms',
  'first_token_ms', 'occurred_at', 'standard_cost_usd_reference', 'user_charge_cny',
];

// PostgreSQL's extended query protocol accepts at most 65,535 bind
// parameters. Keep a little headroom for future columns and split large
// usage batches before constructing the INSERT statement.
export const USAGE_COLUMN_COUNT = USAGE_COLUMNS.length;
export const MAX_USAGE_ROWS_PER_INSERT = Math.max(1, Math.floor(65000 / USAGE_COLUMN_COUNT));

export const REQUIRED_SOURCE_COLUMNS = {
  usage_logs: [
    'id', 'user_id', 'api_key_id', 'account_id', 'request_id', 'model', 'requested_model',
    'upstream_model', 'channel_id', 'group_id', 'subscription_id', 'billing_mode', 'billing_type',
    'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_cost',
    'actual_cost', 'rate_multiplier', 'account_rate_multiplier',
    'duration_ms', 'first_token_ms', 'created_at',
  ],
  users: ['id', 'email', 'username', 'status', 'balance', 'total_recharged', 'updated_at', 'deleted_at'],
  accounts: ['id', 'name', 'platform', 'type', 'status', 'expires_at', 'updated_at', 'deleted_at'],
  payment_orders: [
    'id', 'user_id', 'pay_amount', 'amount', 'provider_snapshot', 'payment_type', 'order_type',
    'plan_id', 'subscription_group_id', 'subscription_days', 'status', 'refund_amount', 'paid_at',
    'refund_at', 'fee_rate', 'recharge_code', 'updated_at',
  ],
  redeem_codes: ['id', 'code', 'type', 'value', 'status', 'used_by', 'used_at', 'notes', 'created_at'],
  user_affiliate_ledger: ['id', 'user_id', 'action', 'amount', 'source_user_id', 'source_order_id', 'created_at', 'updated_at'],
  payment_audit_logs: ['id', 'order_id', 'action', 'detail', 'operator', 'created_at'],
  user_subscriptions: [
    'id', 'user_id', 'group_id', 'starts_at', 'expires_at', 'status', 'daily_usage_usd',
    'weekly_usage_usd', 'monthly_usage_usd', 'updated_at', 'deleted_at',
  ],
};

function valuesPlaceholders(rowCount, columnCount) {
  return Array.from({ length: rowCount }, (_, row) => `(${Array.from({ length: columnCount }, (_, col) => `$${row * columnCount + col + 1}`).join(',')})`).join(',');
}

function decimal(value) {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

function numeric(value) {
  return decimal(value).toString();
}

export function refundCashAmount(orderAmount, payAmount, refundAmount) {
  const amount = decimal(orderAmount);
  const paid = decimal(payAmount);
  const refund = decimal(refundAmount);
  if (amount.lte(0) || paid.lte(0) || refund.lte(0)) return new Decimal(0);
  if (refund.gte(amount)) return paid;
  return paid.mul(refund).div(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function assertSourceUnitContract(config) {
  const unit = String(config?.sourceBalanceUnit || 'CNY').trim().toUpperCase();
  if (unit !== 'CNY') {
    throw new Error(`unsupported SOURCE_BALANCE_UNIT=${unit || '(empty)'}; FinOps requires canonical CNY source amounts`);
  }
  return unit;
}

function dateKey(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sourceTimestamp(cursor) {
  return cursor?.cursor_time || '1970-01-01 00:00:00+00';
}

export class SyncService {
  constructor(pool, config, logger = console) {
    this.pool = pool;
    this.config = config;
    this.logger = logger;
    this.schema = `"${config.finopsSchema}"`;
    this.source = `"${config.sourceSchema}"`;
    this.balanceSettings = `"${config.sourceSettingsSchema || 'finops_source'}"."balance_recharge_multiplier"`;
    this.running = false;
    this.timer = null;
  }

  async validateSourceSchema() {
    assertSourceUnitContract(this.config);
    const tables = Object.keys(REQUIRED_SOURCE_COLUMNS);
    const result = await this.pool.query(
      `SELECT table_name,column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=ANY($2::text[])`,
      [this.config.sourceSchema, tables],
    );
    const found = new Map();
    for (const row of result.rows) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED_SOURCE_COLUMNS)) {
      for (const column of columns) if (!found.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`ApiStation source schema is incompatible; missing: ${missing.join(', ')}`);
    const multiplierResult = await this.pool.query(`
      SELECT value FROM ${this.balanceSettings}
      WHERE key='BALANCE_RECHARGE_MULTIPLIER' LIMIT 1`);
    const rawMultiplier = multiplierResult.rows[0]?.value;
    const multiplier = rawMultiplier === undefined ? 1 : Number(rawMultiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`invalid BALANCE_RECHARGE_MULTIPLIER: ${rawMultiplier}`);
    }
    if (multiplier !== 1) {
      this.logger.warn('[sync] BALANCE_RECHARGE_MULTIPLIER is not 1; treating it as a CNY bonus/discount multiplier, never as a currency conversion', { multiplier });
    }
    return { sourceBalanceUnit: 'CNY', balanceRechargeMultiplier: multiplier, settingPresent: rawMultiplier !== undefined };
  }

  start() {
    if (!this.config.syncEnabled || this.timer) return;
    const tick = async () => {
      try { await this.runOnce(); }
      catch (error) { this.logger.error('[sync] cycle failed', error); }
      finally { if (this.timer) this.timer = setTimeout(tick, this.config.syncIntervalSeconds * 1000); }
    };
    this.timer = setTimeout(tick, 50);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async markSourceError(sourceName, error) {
    try {
      await this.pool.query(`
        INSERT INTO ${this.schema}.sync_cursors(source_name,last_error,updated_at)
        VALUES($1,$2,NOW())
        ON CONFLICT(source_name) DO UPDATE SET last_error=EXCLUDED.last_error,updated_at=NOW()`,
      [sourceName, String(error?.message || error).slice(0, 4000)]);
    } catch (stateError) {
      this.logger.error('[sync] failed to persist source error', sourceName, stateError);
    }
  }

  async drain(sourceName, batch) {
    let total = 0;
    try {
      for (let index = 0; index < this.config.syncMaxBatchesPerCycle; index += 1) {
        const rows = await batch();
        total += rows;
        if (rows < this.config.syncBatchSize) break;
      }
      return total;
    } catch (error) {
      await this.markSourceError(sourceName, error);
      throw error;
    }
  }

  async runOnce() {
    // The service can be invoked without the CLI/server preflight. Refuse to
    // write a ledger whenever the configured source balance unit is not CNY.
    assertSourceUnitContract(this.config);
    if (this.running) return { skipped: true, reason: 'already_running' };
    this.running = true;
    const started = Date.now();
    try {
      await this.syncDimensions();
      const paymentRows = await this.drain('payment_orders', () => this.syncPayments());
      const redeemRows = await this.drain('redeem_codes', () => this.syncRedeemCodes());
      const affiliateRows = await this.drain('user_affiliate_ledger', () => this.syncAffiliateLedger());
      const auditRows = await this.drain('payment_audit_logs', () => this.syncPaymentAuditLogs());
      const subscriptionRows = await this.drain('user_subscriptions', () => this.syncSubscriptions());
      const usageRows = await this.drain('usage_logs', () => this.syncUsage());
      await this.refreshRecentUsage();
      await this.reconcileRecentUsage();
      const result = {
        skipped: false, usageRows, paymentRows, redeemRows, affiliateRows, auditRows, subscriptionRows,
        durationMs: Date.now() - started,
      };
      this.logger.info('[sync] cycle complete', result);
      return result;
    } finally {
      this.running = false;
    }
  }

  async syncDimensions() {
    try {
      await inTransaction(this.pool, async (client) => {
        await client.query(`
          INSERT INTO ${this.schema}.dim_users(
            source_user_id,email,username,status,current_balance,total_recharged,balance_currency,
            source_deleted_at,source_updated_at,synced_at)
          SELECT id,email,COALESCE(username,''),status,balance,COALESCE(total_recharged,0),'CNY',
                 deleted_at,updated_at,NOW()
          FROM ${this.source}.users
          ON CONFLICT(source_user_id) DO UPDATE SET
            email=EXCLUDED.email,username=EXCLUDED.username,status=EXCLUDED.status,
            current_balance=EXCLUDED.current_balance,total_recharged=EXCLUDED.total_recharged,
            source_deleted_at=EXCLUDED.source_deleted_at,source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`);
        await client.query(`
          INSERT INTO ${this.schema}.dim_accounts(
            source_account_id,name,platform,account_type,status,expires_at,source_deleted_at,
            source_updated_at,synced_at)
          SELECT id,name,platform,type,status,expires_at,deleted_at,updated_at,NOW()
          FROM ${this.source}.accounts
          ON CONFLICT(source_account_id) DO UPDATE SET
            name=EXCLUDED.name,platform=EXCLUDED.platform,account_type=EXCLUDED.account_type,
            status=EXCLUDED.status,expires_at=EXCLUDED.expires_at,source_deleted_at=EXCLUDED.source_deleted_at,
            source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`);
      });
    } catch (error) {
      await this.markSourceError('dimensions', error);
      throw error;
    }
  }

  async cursor(client, sourceName) {
    await client.query(`INSERT INTO ${this.schema}.sync_cursors(source_name) VALUES($1) ON CONFLICT DO NOTHING`, [sourceName]);
    const result = await client.query(
      `SELECT cursor_time,cursor_id FROM ${this.schema}.sync_cursors WHERE source_name=$1 FOR UPDATE`,
      [sourceName],
    );
    return result.rows[0];
  }

  async markSuccess(client, sourceName, lastRow, count) {
    if (lastRow) {
      await client.query(`
        UPDATE ${this.schema}.sync_cursors
        SET cursor_time=$1,cursor_id=$2,last_success_at=NOW(),last_error=NULL,
            rows_synced=rows_synced+$3,updated_at=NOW()
        WHERE source_name=$4`, [lastRow.time, lastRow.id, count, sourceName]);
    } else {
      await client.query(`
        UPDATE ${this.schema}.sync_cursors
        SET last_success_at=NOW(),last_error=NULL,updated_at=NOW()
        WHERE source_name=$1`, [sourceName]);
    }
  }

  async syncUsage() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'usage_logs');
      const sourceRows = await client.query(`
        SELECT id AS source_usage_id,
          COALESCE(request_id,'usage:'||id::text) AS request_id,
          user_id AS source_user_id,api_key_id AS source_api_key_id,
          account_id AS source_account_id,COALESCE(group_id,0) AS source_group_id,
          COALESCE(channel_id,0) AS source_channel_id,model,
          COALESCE(requested_model,'') AS requested_model,COALESCE(upstream_model,'') AS upstream_model,
          COALESCE(billing_mode,'token') AS billing_mode,COALESCE(billing_type,0) AS billing_type,
          subscription_id,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
          total_cost AS standard_cost_usd_reference,actual_cost AS user_charge_cny,
          COALESCE(rate_multiplier,1) AS user_rate_multiplier,
          COALESCE(account_rate_multiplier,1) AS account_rate_multiplier,
          duration_ms,first_token_ms,created_at AS occurred_at
        FROM ${this.source}.usage_logs
        WHERE (created_at,id)>($1,$2)
        ORDER BY created_at,id LIMIT $3`,
      [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      if (!sourceRows.rowCount) {
        await this.markSuccess(client, 'usage_logs', null, 0);
        return 0;
      }
      await this.upsertUsageRows(client, sourceRows.rows);
      const last = sourceRows.rows.at(-1);
      await this.markSuccess(client, 'usage_logs', { time: last.occurred_at, id: last.source_usage_id }, sourceRows.rowCount);
      return sourceRows.rowCount;
    });
  }

  async upsertUsageRows(client, rows) {
    if (!rows.length) return;
    const ids = rows.map((row) => row.source_usage_id);
    const users = [...new Set(rows.map((row) => Number(row.source_user_id)).filter(Boolean))];
    const days = new Set(rows.map((row) => dateKey(row.occurred_at, this.config.timezone)));
    const existingResult = await client.query(`
      SELECT source_usage_id,source_user_id,user_charge_cny,billing_type,occurred_at
      FROM ${this.schema}.fact_usage_events WHERE source_usage_id=ANY($1::bigint[])`, [ids]);
    const existing = new Map(existingResult.rows.map((row) => [String(row.source_usage_id), row]));
    const changedUsers = new Set();
    for (const row of rows) {
      const previous = existing.get(String(row.source_usage_id));
      if (previous && (
        Number(previous.source_user_id) !== Number(row.source_user_id)
        || Number(previous.billing_type) !== Number(row.billing_type)
        || !decimal(previous.user_charge_cny).eq(decimal(row.user_charge_cny))
        || new Date(previous.occurred_at).getTime() !== new Date(row.occurred_at).getTime()
      )) {
        changedUsers.add(Number(previous.source_user_id));
        changedUsers.add(Number(row.source_user_id));
      }
      if (previous && new Date(previous.occurred_at).getTime() !== new Date(row.occurred_at).getTime()) {
        days.add(dateKey(previous.occurred_at, this.config.timezone));
      }
    }
    for (const row of rows) {
      row.standard_cost_usd_reference = numeric(row.standard_cost_usd_reference);
      row.user_charge_cny = numeric(row.user_charge_cny);
    }
    for (let offset = 0; offset < rows.length; offset += MAX_USAGE_ROWS_PER_INSERT) {
      const chunk = rows.slice(offset, offset + MAX_USAGE_ROWS_PER_INSERT);
      const params = [];
      for (const row of chunk) for (const column of USAGE_COLUMNS) params.push(row[column] ?? null);
      await client.query(`
        INSERT INTO ${this.schema}.fact_usage_events(${USAGE_COLUMNS.join(',')})
        VALUES ${valuesPlaceholders(chunk.length, USAGE_COLUMNS.length)}
        ON CONFLICT(source_usage_id) DO UPDATE SET
          request_id=EXCLUDED.request_id,source_user_id=EXCLUDED.source_user_id,
          source_api_key_id=EXCLUDED.source_api_key_id,source_account_id=EXCLUDED.source_account_id,
          source_group_id=EXCLUDED.source_group_id,source_channel_id=EXCLUDED.source_channel_id,
          model=EXCLUDED.model,requested_model=EXCLUDED.requested_model,upstream_model=EXCLUDED.upstream_model,
          billing_mode=EXCLUDED.billing_mode,billing_type=EXCLUDED.billing_type,subscription_id=EXCLUDED.subscription_id,
          input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens,
          cache_creation_tokens=EXCLUDED.cache_creation_tokens,cache_read_tokens=EXCLUDED.cache_read_tokens,
          user_rate_multiplier=EXCLUDED.user_rate_multiplier,
          account_rate_multiplier=EXCLUDED.account_rate_multiplier,duration_ms=EXCLUDED.duration_ms,
          first_token_ms=EXCLUDED.first_token_ms,occurred_at=EXCLUDED.occurred_at,
          standard_cost_usd_reference=EXCLUDED.standard_cost_usd_reference,
          user_charge_cny=EXCLUDED.user_charge_cny,
          synced_at=NOW()`, params);
    }
    await client.query(`
      UPDATE ${this.schema}.fact_usage_events
      SET revenue_recognition_status='subscription',recognized_revenue_cny=0
      WHERE source_usage_id=ANY($1::bigint[]) AND billing_type=1`, [ids]);
    for (const userId of changedUsers) if (userId) await this.rebuildUserLedger(client, userId);
    for (const userId of users) if (!changedUsers.has(userId)) await this.allocatePendingUsage(client, userId);
    await this.refreshUsageDaily(client, [...days]);
  }

  async allocatePendingUsage(client, userId) {
    const lotsResult = await client.query(`
      SELECT id,granted_credit,remaining_credit,cash_basis_cny,acquired_at
      FROM ${this.schema}.credit_lots
      WHERE source_user_id=$1 AND status='open' AND remaining_credit>0
      ORDER BY acquired_at,id`, [userId]);
    const usageResult = await client.query(`
      SELECT f.source_usage_id,f.user_charge_cny,f.occurred_at,
        COALESCE(SUM(r.allocated_credit),0) AS allocated_credit,
        COALESCE(SUM(r.recognized_revenue_cny),0) AS recognized_revenue_cny
      FROM ${this.schema}.fact_usage_events f
      LEFT JOIN ${this.schema}.revenue_recognition r ON r.source_usage_id=f.source_usage_id
      WHERE f.source_user_id=$1 AND f.billing_type=0
        AND f.revenue_recognition_status IN ('unallocated','partial')
      GROUP BY f.source_usage_id,f.user_charge_cny,f.occurred_at
      ORDER BY f.occurred_at,f.source_usage_id`, [userId]);
    const lots = lotsResult.rows.map((row) => ({
      ...row, remaining: decimal(row.remaining_credit), granted: decimal(row.granted_credit),
      cash: decimal(row.cash_basis_cny), acquiredAt: new Date(row.acquired_at).getTime(),
    }));
    let lotIndex = 0;
    for (const usage of usageResult.rows) {
      let pending = decimal(usage.user_charge_cny).minus(decimal(usage.allocated_credit));
      let recognized = decimal(usage.recognized_revenue_cny);
      let allocated = decimal(usage.allocated_credit);
      if (pending.lte(0)) {
        await client.query(`UPDATE ${this.schema}.fact_usage_events SET revenue_recognition_status='recognized' WHERE source_usage_id=$1`, [usage.source_usage_id]);
        continue;
      }
      while (pending.gt(0) && lotIndex < lots.length) {
        const lot = lots[lotIndex];
        if (lot.acquiredAt > new Date(usage.occurred_at).getTime()) break;
        const take = Decimal.min(pending, lot.remaining);
        if (take.lte(0)) { lotIndex += 1; continue; }
        const revenue = lot.granted.gt(0) ? take.mul(lot.cash).div(lot.granted) : new Decimal(0);
      await client.query(`
        INSERT INTO ${this.schema}.revenue_recognition(source_usage_id,credit_lot_id,allocated_credit,recognized_revenue_cny,revenue_currency,method)
        VALUES($1,$2,$3,$4,'CNY','fifo')
          ON CONFLICT(source_usage_id,credit_lot_id) DO UPDATE SET
            allocated_credit=EXCLUDED.allocated_credit,recognized_revenue_cny=EXCLUDED.recognized_revenue_cny`,
        [usage.source_usage_id, lot.id, take.toString(), revenue.toString()]);
        lot.remaining = lot.remaining.minus(take);
        pending = pending.minus(take);
        allocated = allocated.plus(take);
        recognized = recognized.plus(revenue);
        await client.query(`
          UPDATE ${this.schema}.credit_lots SET remaining_credit=$1,status=CASE WHEN $1::numeric<=0 THEN 'exhausted' ELSE 'open' END,updated_at=NOW()
          WHERE id=$2`, [lot.remaining.toString(), lot.id]);
        if (lot.remaining.lte(0)) lotIndex += 1;
      }
      const status = pending.lte(0) ? 'recognized' : allocated.gt(0) ? 'partial' : 'unallocated';
      await client.query(`UPDATE ${this.schema}.fact_usage_events SET recognized_revenue_cny=$1,revenue_recognition_status=$2 WHERE source_usage_id=$3`, [recognized.toString(), status, usage.source_usage_id]);
    }
  }

  async refreshUsageDaily(client, days) {
    if (!days.length) return;
    await client.query(`DELETE FROM ${this.schema}.fact_usage_daily WHERE day=ANY($1::date[])`, [days]);
      await client.query(`
        INSERT INTO ${this.schema}.fact_usage_daily(
        day,source_user_id,source_api_key_id,source_account_id,source_group_id,model,billing_mode,billing_type,
        requests,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
        standard_cost_usd_reference,user_charge_cny,
        recognized_revenue_cny)
      SELECT (occurred_at AT TIME ZONE $2)::date,source_user_id,source_api_key_id,source_account_id,source_group_id,
        model,billing_mode,billing_type,COUNT(*),SUM(input_tokens),SUM(output_tokens),SUM(cache_creation_tokens),SUM(cache_read_tokens),
        SUM(standard_cost_usd_reference),SUM(user_charge_cny),SUM(recognized_revenue_cny)
      FROM ${this.schema}.fact_usage_events
      WHERE (occurred_at AT TIME ZONE $2)::date=ANY($1::date[])
      GROUP BY (occurred_at AT TIME ZONE $2)::date,source_user_id,source_api_key_id,source_account_id,source_group_id,model,billing_mode,billing_type`,
    [days, this.config.timezone]);
  }

  async refreshRecentUsage() {
    if (!this.config.syncLookbackSeconds) return;
    await inTransaction(this.pool, async (client) => {
      const since = new Date(Date.now() - this.config.syncLookbackSeconds * 1000);
      const rows = await client.query(`
        SELECT id AS source_usage_id,COALESCE(request_id,'usage:'||id::text) AS request_id,
          user_id AS source_user_id,api_key_id AS source_api_key_id,account_id AS source_account_id,
          COALESCE(group_id,0) AS source_group_id,COALESCE(channel_id,0) AS source_channel_id,model,
          COALESCE(requested_model,'') AS requested_model,COALESCE(upstream_model,'') AS upstream_model,
          COALESCE(billing_mode,'token') AS billing_mode,COALESCE(billing_type,0) AS billing_type,subscription_id,
          input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
          total_cost AS standard_cost_usd_reference,actual_cost AS user_charge_cny,
          COALESCE(rate_multiplier,1) AS user_rate_multiplier,COALESCE(account_rate_multiplier,1) AS account_rate_multiplier,
          duration_ms,first_token_ms,created_at AS occurred_at
        FROM ${this.source}.usage_logs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`, [since, this.config.syncBatchSize]);
      if (rows.rowCount) await this.upsertUsageRows(client, rows.rows);
    });
  }

  async syncPayments() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'payment_orders');
      const sourceRows = await client.query(`
        SELECT id,user_id,pay_amount,amount,COALESCE(provider_snapshot->>'currency','CNY') AS currency,
          provider_snapshot,payment_type,order_type,plan_id,subscription_group_id,subscription_days,status,
          refund_amount,paid_at,refund_at,fee_rate,recharge_code,updated_at
        FROM ${this.source}.payment_orders
        WHERE (updated_at,id)>($1,$2) ORDER BY updated_at,id LIMIT $3`,
      [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      const users = new Set();
      for (const row of sourceRows.rows) {
        const affectedUsers = await this.upsertPaymentRow(client, row);
        for (const userId of affectedUsers) users.add(Number(userId));
      }
      for (const userId of users) if (userId) await this.rebuildUserLedger(client, userId);
      if (!sourceRows.rowCount) await this.markSuccess(client, 'payment_orders', null, 0);
      else {
        const last = sourceRows.rows.at(-1);
        await this.markSuccess(client, 'payment_orders', { time: last.updated_at, id: last.id }, sourceRows.rowCount);
      }
      return sourceRows.rowCount;
    });
  }

  async upsertPaymentRow(client, row) {
    const previousEvents = await client.query(`
      SELECT DISTINCT source_user_id FROM ${this.schema}.credit_events
      WHERE source_table='payment_orders' AND source_id=$1`, [row.id]);
    const affectedUsers = new Set([Number(row.user_id)]);
    for (const previous of previousEvents.rows) affectedUsers.add(Number(previous.source_user_id));
    const orderType = row.order_type || 'balance';
    const currency = String(row.currency || 'CNY').toUpperCase();
    const pay = decimal(row.pay_amount);
    const credited = orderType === 'balance' ? decimal(row.amount) : new Decimal(0);
    const basePaid = currency === 'CNY' ? pay : new Decimal(0);
    const cashStatus = currency === 'CNY' ? 'confirmed' : 'pending_fx';
    const paymentType = String(row.payment_type || '');
    const transactionType = orderType === 'subscription' ? 'subscription_purchase' : 'recharge';
    const metadata = JSON.stringify({
      credited_amount: credited.toString(), order_type: orderType, plan_id: row.plan_id,
      subscription_group_id: row.subscription_group_id, subscription_days: row.subscription_days,
      fee_rate: row.fee_rate, recharge_code: row.recharge_code || '', provider_snapshot: row.provider_snapshot || {},
    });
    await client.query(`
      UPDATE ${this.schema}.cash_transactions
      SET status='void',source_status=$3,source_updated_at=$4,synced_at=NOW()
      WHERE source_table='payment_orders' AND source_id=$1
        AND transaction_type IN ('recharge','subscription_purchase')
        AND (transaction_type<>$2 OR $5::boolean=FALSE)`,
    [row.id, transactionType, row.status || '', row.updated_at, Boolean(row.paid_at)]);
    if (row.paid_at) {
      await client.query(`
        INSERT INTO ${this.schema}.cash_transactions(
          source_table,source_id,transaction_type,direction,original_amount,original_currency,base_amount,
          source_user_id,payment_method,status,occurred_at,order_type,credited_amount,credited_currency,source_status,source_updated_at,metadata)
        VALUES('payment_orders',$1,$2,'in',$3,$4,$5,$6,$7,$8,$9,$10,$11,'CNY',$12,$13,$14::jsonb)
        ON CONFLICT(source_table,source_id,transaction_type) DO UPDATE SET
          original_amount=EXCLUDED.original_amount,original_currency=EXCLUDED.original_currency,base_amount=EXCLUDED.base_amount,
          source_user_id=EXCLUDED.source_user_id,payment_method=EXCLUDED.payment_method,status=EXCLUDED.status,
          occurred_at=EXCLUDED.occurred_at,order_type=EXCLUDED.order_type,credited_amount=EXCLUDED.credited_amount,
          credited_currency=EXCLUDED.credited_currency,source_status=EXCLUDED.source_status,source_updated_at=EXCLUDED.source_updated_at,
          metadata=EXCLUDED.metadata,synced_at=NOW()`,
      [row.id, transactionType, pay.toString(), currency, basePaid.toString(), row.user_id, paymentType, cashStatus,
        row.paid_at, orderType, credited.toString(), row.status || '', row.updated_at, metadata]);
    }
    const refund = decimal(row.refund_amount);
    if (row.refund_at && refund.gt(0)) {
      const refundCash = refundCashAmount(row.amount, row.pay_amount, refund);
      const refundBase = currency === 'CNY' ? refundCash : new Decimal(0);
      await client.query(`
        INSERT INTO ${this.schema}.cash_transactions(
          source_table,source_id,transaction_type,direction,original_amount,original_currency,base_amount,
          source_user_id,payment_method,status,occurred_at,order_type,credited_amount,credited_currency,
          source_status,refund_base_amount,refund_credit_amount,is_reversal,source_updated_at,metadata)
        VALUES('payment_orders',$1,'refund','out',$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13,TRUE,$14,$15::jsonb)
        ON CONFLICT(source_table,source_id,transaction_type) DO UPDATE SET
          original_amount=EXCLUDED.original_amount,original_currency=EXCLUDED.original_currency,base_amount=EXCLUDED.base_amount,
          source_user_id=EXCLUDED.source_user_id,payment_method=EXCLUDED.payment_method,status=EXCLUDED.status,
          occurred_at=EXCLUDED.occurred_at,order_type=EXCLUDED.order_type,credited_amount=EXCLUDED.credited_amount,
          credited_currency=EXCLUDED.credited_currency,is_reversal=EXCLUDED.is_reversal,
          refund_base_amount=EXCLUDED.refund_base_amount,refund_credit_amount=EXCLUDED.refund_credit_amount,
          source_status=EXCLUDED.source_status,source_updated_at=EXCLUDED.source_updated_at,metadata=EXCLUDED.metadata,synced_at=NOW()`,
      [row.id, refundCash.toString(), currency, refundBase.toString(), row.user_id, paymentType, 'confirmed', row.refund_at,
        orderType, refund.toString(), row.status || '', refundBase.toString(), refund.toString(), row.updated_at,
        JSON.stringify({ refund_credit_amount: refund.toString(), refund_base_amount: refundBase.toString(), order_type: orderType })]);
    } else {
      await client.query(`
        UPDATE ${this.schema}.cash_transactions
        SET status='void',source_status=$2,source_updated_at=$3,synced_at=NOW()
        WHERE source_table='payment_orders' AND source_id=$1 AND transaction_type='refund'`,
      [row.id, row.status || '', row.updated_at]);
    }
    if (row.paid_at && orderType === 'balance' && credited.gt(0)) {
      await this.upsertCreditEvent(client, {
        sourceTable: 'payment_orders', sourceId: row.id, sourceVersion: 'recharge', sourceUserId: row.user_id,
        eventType: 'recharge', direction: 'in', creditAmount: credited, creditCurrency: 'CNY',
        cashBasisCny: basePaid, originalAmount: pay, originalCurrency: currency, occurredAt: row.paid_at,
        metadata: { order_type: orderType, recharge_code: row.recharge_code || '', cash_status: cashStatus },
      });
    } else {
      await this.voidCreditEvent(client, 'payment_orders', row.id, 'recharge', 'payment_not_creditable', row.updated_at);
    }
    if (row.paid_at && row.refund_at && refund.gt(0) && orderType === 'balance') {
      const refundCash = refundCashAmount(row.amount, row.pay_amount, refund);
      await this.upsertCreditEvent(client, {
        sourceTable: 'payment_orders', sourceId: row.id, sourceVersion: 'refund', sourceUserId: row.user_id,
        eventType: 'refund', direction: 'out', creditAmount: refund, creditCurrency: 'CNY',
        cashBasisCny: currency === 'CNY' ? refundCash : 0, originalAmount: refund, originalCurrency: 'CNY',
        occurredAt: row.refund_at, metadata: { order_type: orderType, refund_cash_cny: refundCash.toString() },
      });
    } else {
      await this.voidCreditEvent(client, 'payment_orders', row.id, 'refund', 'refund_not_effective', row.updated_at);
    }
    return affectedUsers;
  }

  async voidCreditEvent(client, sourceTable, sourceId, sourceVersion, reason, sourceUpdatedAt) {
    await client.query(`
      UPDATE ${this.schema}.credit_events
      SET credit_amount=0,cash_basis_cny=0,
        metadata=metadata || $4::jsonb,synced_at=NOW()
      WHERE source_table=$1 AND source_id=$2 AND source_version=$3`,
    [sourceTable, sourceId, sourceVersion, JSON.stringify({ voided: true, reason, source_updated_at: sourceUpdatedAt || null })]);
  }

  async upsertCreditEvent(client, event) {
    const result = await client.query(`
      INSERT INTO ${this.schema}.credit_events(
        source_table,source_id,source_version,source_user_id,event_type,direction,credit_amount,credit_currency,
        cash_basis_cny,original_amount,original_currency,occurred_at,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT(source_table,source_id,source_version) DO UPDATE SET
        source_user_id=EXCLUDED.source_user_id,event_type=EXCLUDED.event_type,direction=EXCLUDED.direction,
        credit_amount=EXCLUDED.credit_amount,credit_currency=EXCLUDED.credit_currency,cash_basis_cny=EXCLUDED.cash_basis_cny,
        original_amount=EXCLUDED.original_amount,original_currency=EXCLUDED.original_currency,occurred_at=EXCLUDED.occurred_at,
        metadata=EXCLUDED.metadata,synced_at=NOW()
      RETURNING id`,
    [event.sourceTable, event.sourceId, event.sourceVersion, event.sourceUserId, event.eventType, event.direction,
      numeric(event.creditAmount), 'CNY', numeric(event.cashBasisCny), numeric(event.originalAmount), event.originalCurrency,
      event.occurredAt, JSON.stringify(event.metadata || {})]);
    return result.rows[0].id;
  }

  async syncRedeemCodes() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'redeem_codes');
      const sourceRows = await client.query(`
        SELECT rc.id,rc.code,rc.type,rc.value,rc.status,rc.used_by,rc.used_at,rc.notes,rc.created_at,
          po.id AS payment_order_id,po.amount AS payment_amount,po.pay_amount AS payment_pay_amount,
          COALESCE(po.provider_snapshot->>'currency','CNY') AS payment_currency
        FROM ${this.source}.redeem_codes rc
        LEFT JOIN ${this.source}.payment_orders po ON po.recharge_code=rc.code AND po.order_type='balance' AND po.paid_at IS NOT NULL
        WHERE (COALESCE(rc.used_at,rc.created_at),rc.id)>($1,$2)
        ORDER BY COALESCE(rc.used_at,rc.created_at),rc.id LIMIT $3`,
      [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      const users = new Set();
      for (const row of sourceRows.rows) {
        if (!row.used_by || !row.used_at || !['balance', 'admin_balance'].includes(row.type)) continue;
        const value = decimal(row.value);
        const direction = value.gte(0) ? 'in' : 'out';
        const creditAmount = value.abs();
        let cashBasis = new Decimal(0);
        if (row.type === 'balance' && row.payment_order_id && decimal(row.payment_amount).gt(0)) {
          cashBasis = decimal(row.payment_pay_amount).mul(creditAmount).div(decimal(row.payment_amount));
          if (String(row.payment_currency).toUpperCase() !== 'CNY') cashBasis = new Decimal(0);
        }
        await this.upsertCreditEvent(client, {
          sourceTable: 'redeem_codes', sourceId: row.id, sourceVersion: 'used', sourceUserId: row.used_by,
          eventType: row.type === 'admin_balance' ? 'admin_adjustment' : 'redeem', direction,
          creditAmount, creditCurrency: 'CNY', cashBasisCny: cashBasis,
          originalAmount: creditAmount, originalCurrency: 'CNY', occurredAt: row.used_at,
          metadata: {
            code: row.code, redeem_type: row.type, linked_payment_order_id: row.payment_order_id || null,
            linked_recharge: Boolean(row.payment_order_id), notes: row.notes || '',
          },
        });
        users.add(Number(row.used_by));
      }
      for (const userId of users) if (userId) await this.rebuildUserLedger(client, userId);
      if (!sourceRows.rowCount) await this.markSuccess(client, 'redeem_codes', null, 0);
      else {
        const last = sourceRows.rows.at(-1);
        await this.markSuccess(client, 'redeem_codes', { time: last.used_at || last.created_at, id: last.id }, sourceRows.rowCount);
      }
      return sourceRows.rowCount;
    });
  }

  async syncAffiliateLedger() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'user_affiliate_ledger');
      const sourceRows = await client.query(`
        SELECT id,user_id,action,amount,source_user_id,source_order_id,created_at,updated_at
        FROM ${this.source}.user_affiliate_ledger
        WHERE (updated_at,id)>($1,$2) ORDER BY updated_at,id LIMIT $3`,
      [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      const users = new Set();
      for (const row of sourceRows.rows) {
        const amount = decimal(row.amount);
        if (amount.eq(0)) continue;
        const direction = amount.gte(0) ? 'in' : 'out';
        await this.upsertCreditEvent(client, {
          sourceTable: 'user_affiliate_ledger', sourceId: row.id, sourceVersion: row.action,
          sourceUserId: row.user_id, eventType: 'affiliate_rebate', direction, creditAmount: amount.abs(),
          creditCurrency: 'CNY', cashBasisCny: 0, originalAmount: amount.abs(), originalCurrency: 'CNY',
          occurredAt: row.created_at, metadata: {
            action: row.action, source_user_id: row.source_user_id || null, source_order_id: row.source_order_id || null,
            accounting_scope: row.action === 'accrue' ? 'affiliate_quota' : 'user_balance',
          },
        });
        users.add(Number(row.user_id));
      }
      for (const userId of users) if (userId) await this.rebuildUserLedger(client, userId);
      if (!sourceRows.rowCount) await this.markSuccess(client, 'user_affiliate_ledger', null, 0);
      else {
        const last = sourceRows.rows.at(-1);
        await this.markSuccess(client, 'user_affiliate_ledger', { time: last.updated_at, id: last.id }, sourceRows.rowCount);
      }
      return sourceRows.rowCount;
    });
  }

  async syncPaymentAuditLogs() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'payment_audit_logs');
      const rows = await client.query(`
        SELECT id,order_id,action,detail,operator,created_at
        FROM ${this.source}.payment_audit_logs WHERE (created_at,id)>($1,$2)
        ORDER BY created_at,id LIMIT $3`, [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      for (const row of rows.rows) {
        await client.query(`
          INSERT INTO ${this.schema}.source_audit_events(source_audit_id,source_table,source_object_id,action,detail,operator,occurred_at)
          VALUES($1,'payment_orders',$2,$3,$4,$5,$6)
          ON CONFLICT(source_audit_id) DO UPDATE SET action=EXCLUDED.action,detail=EXCLUDED.detail,operator=EXCLUDED.operator,occurred_at=EXCLUDED.occurred_at,synced_at=NOW()`,
        [row.id, row.order_id, row.action, row.detail || '', row.operator || '', row.created_at]);
      }
      if (!rows.rowCount) await this.markSuccess(client, 'payment_audit_logs', null, 0);
      else {
        const last = rows.rows.at(-1);
        await this.markSuccess(client, 'payment_audit_logs', { time: last.created_at, id: last.id }, rows.rowCount);
      }
      return rows.rowCount;
    });
  }

  async syncSubscriptions() {
    return inTransaction(this.pool, async (client) => {
      const cursor = await this.cursor(client, 'user_subscriptions');
      const rows = await client.query(`
        SELECT id,user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,updated_at,deleted_at
        FROM ${this.source}.user_subscriptions WHERE (updated_at,id)>($1,$2)
        ORDER BY updated_at,id LIMIT $3`, [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
      for (const row of rows.rows) {
        await client.query(`
          INSERT INTO ${this.schema}.dim_subscriptions(source_subscription_id,source_user_id,source_group_id,starts_at,expires_at,status,
            daily_usage_usd,weekly_usage_usd,monthly_usage_usd,source_deleted_at,source_updated_at,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
          ON CONFLICT(source_subscription_id) DO UPDATE SET source_user_id=EXCLUDED.source_user_id,source_group_id=EXCLUDED.source_group_id,
            starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at,status=EXCLUDED.status,daily_usage_usd=EXCLUDED.daily_usage_usd,
            weekly_usage_usd=EXCLUDED.weekly_usage_usd,monthly_usage_usd=EXCLUDED.monthly_usage_usd,source_deleted_at=EXCLUDED.source_deleted_at,
            source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`,
        [row.id, row.user_id, row.group_id, row.starts_at, row.expires_at, row.status, row.daily_usage_usd || 0,
          row.weekly_usage_usd || 0, row.monthly_usage_usd || 0, row.deleted_at, row.updated_at]);
      }
      if (!rows.rowCount) await this.markSuccess(client, 'user_subscriptions', null, 0);
      else {
        const last = rows.rows.at(-1);
        await this.markSuccess(client, 'user_subscriptions', { time: last.updated_at, id: last.id }, rows.rowCount);
      }
      return rows.rowCount;
    });
  }

  async rebuildUserLedger(client, userId) {
    await client.query(`
      DELETE FROM ${this.schema}.revenue_recognition
      WHERE source_usage_id IN (SELECT source_usage_id FROM ${this.schema}.fact_usage_events WHERE source_user_id=$1)`, [userId]);
    await client.query(`
      UPDATE ${this.schema}.fact_usage_events SET recognized_revenue_cny=0,
        revenue_recognition_status=CASE WHEN billing_type=1 THEN 'subscription' ELSE 'unallocated' END
      WHERE source_user_id=$1`, [userId]);
    await client.query(`DELETE FROM ${this.schema}.credit_lots WHERE source_user_id=$1`, [userId]);
    const events = await client.query(`
      SELECT * FROM (
        SELECT 'credit' AS kind,0 AS kind_order,id AS event_id,occurred_at,direction,credit_amount,cash_basis_cny,metadata
        FROM ${this.schema}.credit_events WHERE source_user_id=$1
        UNION ALL
        SELECT 'usage' AS kind,1 AS kind_order,source_usage_id AS event_id,occurred_at,'out' AS direction,
          user_charge_cny AS credit_amount,0::numeric AS cash_basis_cny,'{}'::jsonb AS metadata
        FROM ${this.schema}.fact_usage_events WHERE source_user_id=$1 AND billing_type=0
      ) ledger_events
      ORDER BY occurred_at,kind_order,event_id`, [userId]);
    const lots = [];
    const deficits = [];
    for (const item of events.rows) {
      const amount = decimal(item.credit_amount);
      if (amount.lte(0)) continue;
      if (item.kind === 'credit') {
        const metadata = item.metadata || {};
        if (item.direction === 'in' && metadata.accounting_scope !== 'affiliate_quota' && !metadata.linked_recharge) {
          const lotType = metadata.order_type === 'balance' ? 'paid' : metadata.redeem_type === 'admin_balance' ? 'admin' : 'gift';
          const lot = await client.query(`
            INSERT INTO ${this.schema}.credit_lots(source_event_id,source_user_id,granted_credit,remaining_credit,cash_basis_cny,credit_currency,acquired_at,lot_type,metadata)
            VALUES($1,$2,$3,$3,$4,'CNY',$5,$6,$7::jsonb) RETURNING id,granted_credit,remaining_credit,cash_basis_cny`,
          [item.event_id, userId, amount.toString(), item.cash_basis_cny || 0, item.occurred_at, lotType, JSON.stringify(metadata)]);
          lots.push({ id: lot.rows[0].id, granted: decimal(lot.rows[0].granted_credit), remaining: decimal(lot.rows[0].remaining_credit), cash: decimal(lot.rows[0].cash_basis_cny) });
          while (deficits.length && lots.at(-1).remaining.gt(0)) {
            const deficit = deficits[0];
            const result = await this.consumeLots(client, lots, deficit.remaining, deficit.usageId);
            deficit.remaining = result.pending;
            if (deficit.remaining.lte(0)) deficits.shift();
            else break;
          }
        } else if (item.direction === 'out') {
          const result = await this.consumeLots(client, lots, amount, null);
          if (result.pending.gt(0)) deficits.push({ usageId: null, remaining: result.pending });
        }
      } else {
        const result = await this.consumeLots(client, lots, amount, item.event_id);
        if (result.pending.gt(0)) deficits.push({ usageId: item.event_id, remaining: result.pending });
      }
    }
    await client.query(`
      UPDATE ${this.schema}.fact_usage_events f
      SET recognized_revenue_cny=rollup.recognized_revenue_cny,
        revenue_recognition_status=CASE
        WHEN rollup.allocated_credit>=rollup.user_charge_cny THEN 'recognized'
          WHEN rollup.allocated_credit>0 THEN 'partial'
          ELSE 'unallocated'
        END
      FROM (
        SELECT u.source_usage_id,u.user_charge_cny,
          COALESCE(SUM(r.allocated_credit),0) AS allocated_credit,
          COALESCE(SUM(r.recognized_revenue_cny),0) AS recognized_revenue_cny
        FROM ${this.schema}.fact_usage_events u
        LEFT JOIN ${this.schema}.revenue_recognition r ON r.source_usage_id=u.source_usage_id
        WHERE u.source_user_id=$1 AND u.billing_type=0
        GROUP BY u.source_usage_id,u.user_charge_cny
      ) rollup
      WHERE f.source_usage_id=rollup.source_usage_id`, [userId]);
    const usageDays = [...new Set(events.rows.filter((item) => item.kind === 'usage').map((item) => dateKey(item.occurred_at, this.config.timezone)))];
    await this.refreshUsageDaily(client, usageDays);
  }

  async consumeLots(client, lots, amount, usageId) {
    let pending = decimal(amount);
    let lotIndex = 0;
    let recognized = new Decimal(0);
    let allocated = new Decimal(0);
    while (pending.gt(0) && lotIndex < lots.length) {
      const lot = lots[lotIndex];
      const take = Decimal.min(pending, lot.remaining);
      if (take.lte(0)) { lotIndex += 1; continue; }
      if (usageId !== null) {
        const revenue = lot.granted.gt(0) ? take.mul(lot.cash).div(lot.granted) : new Decimal(0);
        await client.query(`
          INSERT INTO ${this.schema}.revenue_recognition(source_usage_id,credit_lot_id,allocated_credit,recognized_revenue_cny,revenue_currency,method)
          VALUES($1,$2,$3,$4,'CNY','fifo') ON CONFLICT(source_usage_id,credit_lot_id) DO UPDATE SET
            allocated_credit=EXCLUDED.allocated_credit,recognized_revenue_cny=EXCLUDED.recognized_revenue_cny`,
        [usageId, lot.id, take.toString(), revenue.toString()]);
        recognized = recognized.plus(revenue);
      }
      allocated = allocated.plus(take);
      lot.remaining = lot.remaining.minus(take);
      pending = pending.minus(take);
      await client.query(`UPDATE ${this.schema}.credit_lots SET remaining_credit=$1,status=CASE WHEN $1::numeric<=0 THEN 'exhausted' ELSE 'open' END,updated_at=NOW() WHERE id=$2`, [lot.remaining.toString(), lot.id]);
      if (lot.remaining.lte(0)) lotIndex += 1;
    }
    return { pending, recognized, allocated };
  }

  async reconcileRecentUsage() {
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000);
    const source = await this.pool.query(`SELECT COALESCE(SUM(actual_cost),0) AS total FROM ${this.source}.usage_logs WHERE created_at >= $1 AND created_at < $2`, [start, end]);
    const finops = await this.pool.query(`SELECT COALESCE(SUM(user_charge_cny),0) AS total FROM ${this.schema}.fact_usage_events WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const sourceTotal = source.rows[0].total;
    const finopsTotal = finops.rows[0].total;
    await this.pool.query(`
      INSERT INTO ${this.schema}.reconciliation_runs(reconciliation_type,period_start,period_end,status,source_total,finops_total,difference,details,completed_at)
      VALUES('usage_cny',$1,$2,CASE WHEN ABS($3::numeric-$4::numeric)<0.000001 THEN 'matched' ELSE 'warning' END,$3,$4,$3::numeric-$4::numeric,$5::jsonb,NOW())`,
    [start, end, sourceTotal, finopsTotal, JSON.stringify({ unit: 'CNY', sourceField: 'actual_cost', finopsField: 'user_charge_cny' })]);
  }
}
