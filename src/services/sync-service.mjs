import Decimal from 'decimal.js/decimal.mjs';
import { inTransaction } from '../db.mjs';
import {
  calculateMultiplierCostCny,
  effectiveObservedMultiplierAt,
  normalizeUpstreamBillingSnapshot,
} from './cost-accounting.mjs';

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
export const COST_SNAPSHOT_BATCH_SIZE = 10_000;
export const COST_SNAPSHOT_OPEN_DAYS = 3;
export const USAGE_COST_SNAPSHOT_OPEN_DAYS = 1;
export const COST_SNAPSHOT_COLUMN_COUNT = 24;
export const MAX_COST_SNAPSHOT_ROWS_PER_INSERT = Math.max(1, Math.floor(65000 / COST_SNAPSHOT_COLUMN_COUNT));

export const REQUIRED_SOURCE_COLUMNS = {
  usage_logs: [
    'id', 'user_id', 'api_key_id', 'account_id', 'request_id', 'model', 'requested_model',
    'upstream_model', 'channel_id', 'group_id', 'billing_mode',
    'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'total_cost',
    'actual_cost', 'rate_multiplier', 'account_rate_multiplier',
    'duration_ms', 'first_token_ms', 'created_at',
  ],
  users: ['id', 'email', 'username', 'status', 'balance', 'total_recharged', 'updated_at', 'deleted_at'],
  accounts: ['id', 'name', 'platform', 'type', 'status', 'expires_at', 'updated_at', 'deleted_at', 'extra'],
  payment_orders: [
    'id', 'user_id', 'pay_amount', 'amount', 'provider_snapshot', 'payment_type', 'order_type',
    'status', 'refund_amount', 'paid_at',
    'refund_at', 'fee_rate', 'recharge_code', 'updated_at',
  ],
  redeem_codes: ['id', 'code', 'type', 'value', 'status', 'used_by', 'used_at', 'notes', 'created_at'],
  user_affiliate_ledger: ['id', 'user_id', 'action', 'amount', 'source_user_id', 'source_order_id', 'created_at', 'updated_at'],
  payment_audit_logs: ['id', 'order_id', 'action', 'detail', 'operator', 'created_at'],
};

export const OPTIONAL_SOURCE_COLUMNS = {
  usage_logs: ['subscription_id', 'billing_type'],
  payment_orders: ['plan_id', 'subscription_group_id', 'subscription_days'],
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

function normalizedGroupName(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

export function summarizeChannelMonitorGroup(monitors = []) {
  const enabled = monitors.filter((monitor) => monitor?.enabled !== false);
  if (!enabled.length) {
    return {
      status: 'unknown',
      availableCount: 0,
      totalCount: 0,
      availabilityPercent: null,
      averageLatencyMs: null,
      averagePingLatencyMs: null,
    };
  }
  const statuses = enabled.map((monitor) => String(monitor.primaryStatus || '').trim().toLowerCase());
  const known = statuses.filter(Boolean);
  const availableCount = statuses.filter((status) => status === 'operational' || status === 'degraded').length;
  const totalCount = enabled.length;
  const availabilityValues = enabled
    .filter((monitor) => String(monitor.primaryStatus || '').trim())
    .map((monitor) => Number(monitor.availability7d))
    .filter(Number.isFinite);
  const latencyValues = enabled
    .map((monitor) => Number(monitor.primaryLatencyMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const pingLatencyValues = enabled
    .map((monitor) => Number(monitor.primaryPingLatencyMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  let status = 'unknown';
  if (known.length) {
    if (!availableCount) status = 'unavailable';
    else if (availableCount < totalCount || statuses.some((value) => value === 'degraded')) status = 'degraded';
    else status = 'healthy';
  }
  return {
    status,
    availableCount,
    totalCount,
    availabilityPercent: availabilityValues.length
      ? Number((availabilityValues.reduce((total, value) => total + value, 0) / availabilityValues.length).toFixed(2))
      : null,
    averageLatencyMs: latencyValues.length
      ? Math.round(latencyValues.reduce((total, value) => total + value, 0) / latencyValues.length)
      : null,
    averagePingLatencyMs: pingLatencyValues.length
      ? Math.round(pingLatencyValues.reduce((total, value) => total + value, 0) / pingLatencyValues.length)
      : null,
  };
}

export class SyncService {
  constructor(sourcePool, finopsPoolOrConfig, configOrLogger, logger = console) {
    // Keep the legacy three-argument form for unit tests only. Production
    // callers pass distinct source and FinOps pools.
    if (finopsPoolOrConfig && typeof finopsPoolOrConfig.finopsSchema === 'string') {
      this.sourcePool = sourcePool;
      this.finopsPool = sourcePool;
      this.config = finopsPoolOrConfig;
      this.logger = configOrLogger || console;
    } else {
      this.sourcePool = sourcePool;
      this.finopsPool = finopsPoolOrConfig;
      this.config = configOrLogger;
      this.logger = logger;
    }
    this.schema = `"${this.config.finopsSchema}"`;
    this.source = `"${this.config.sourceSchema}"`;
    this.balanceSettings = `"${this.config.sourceSettingsSchema || 'finops_source'}"."balance_recharge_multiplier"`;
    this.running = false;
    this.timer = null;
    this.runtimeRefreshing = false;
    this.runtimeRefreshPromise = null;
    this.costRefreshPromise = null;
    this.lastRuntimeRefreshAt = 0;
    this.runtimeTimer = null;
    this.channelMonitorReader = null;
    this.sourceGroupCatalogReader = null;
    this.sourceGroupCatalogWriter = null;
    this.runtimeStatusReader = null;
    this.runtimeConcurrencyReader = null;
    this.readCacheInvalidator = null;
    this.sub2ApiAccessToken = '';
    this.sub2ApiAccessTokenProvider = null;
  }

  setChannelMonitorReader(reader) {
    this.channelMonitorReader = typeof reader === 'function' ? reader : null;
  }

  setSourceGroupCatalogReader(reader) {
    this.sourceGroupCatalogReader = typeof reader === 'function' ? reader : null;
  }

  setSourceGroupCatalogWriter(writer) {
    this.sourceGroupCatalogWriter = typeof writer === 'function' ? writer : null;
  }

  setRuntimeStatusReader(reader) {
    this.runtimeStatusReader = typeof reader === 'function' ? reader : null;
  }

  setRuntimeConcurrencyReader(reader) {
    this.runtimeConcurrencyReader = typeof reader === 'function' ? reader : null;
  }

  setReadCacheInvalidator(invalidator) {
    this.readCacheInvalidator = typeof invalidator === 'function' ? invalidator : null;
  }

  setSub2ApiAccessToken(accessToken) {
    this.sub2ApiAccessToken = String(accessToken || '').trim();
  }

  setSub2ApiAccessTokenProvider(provider) {
    this.sub2ApiAccessTokenProvider = provider && (
      typeof provider.getAccessToken === 'function'
      || typeof provider.getAuthentication === 'function'
    ) ? provider : null;
  }

  clearSub2ApiAccessToken() {
    this.sub2ApiAccessToken = '';
  }

  async withSub2ApiAccessToken(reader) {
    const serviceAuthentication = this.sub2ApiAccessTokenProvider?.getAuthentication
      ? await this.sub2ApiAccessTokenProvider.getAuthentication()
      : null;
    const serviceToken = serviceAuthentication?.credential
      || (this.sub2ApiAccessTokenProvider ? await this.sub2ApiAccessTokenProvider.getAccessToken() : '');
    const accessToken = String(serviceToken || this.sub2ApiAccessToken || '').trim();
    if (!accessToken) return null;
    try {
      return await reader({ accessToken, authHeaders: serviceAuthentication?.headers || null });
    } catch (error) {
      if ((error?.statusCode === 401 || error?.statusCode === 403) && serviceToken) {
        await this.sub2ApiAccessTokenProvider.invalidateAccessToken(serviceToken);
        const retryAuthentication = this.sub2ApiAccessTokenProvider?.getAuthentication
          ? await this.sub2ApiAccessTokenProvider.getAuthentication({ force: true })
          : null;
        const retryToken = retryAuthentication?.credential
          || await this.sub2ApiAccessTokenProvider.getAccessToken({ force: true });
        return reader({ accessToken: retryToken, authHeaders: retryAuthentication?.headers || null });
      }
      if (error?.statusCode === 401 || error?.statusCode === 403) this.clearSub2ApiAccessToken();
      throw error;
    }
  }

  async readChannelMonitors() {
    if (!this.channelMonitorReader) return null;
    try {
      return await this.withSub2ApiAccessToken((authentication) => this.channelMonitorReader(authentication));
    } catch (error) {
      this.logger.warn('[monitor] failed to read sub2api channel monitors', error?.code || error?.message || error);
      return null;
    }
  }

  async refreshSourceGroupCatalog() {
    if (!this.sourceGroupCatalogReader || !this.sourceGroupCatalogWriter) return null;
    try {
      const groups = await this.withSub2ApiAccessToken((authentication) => this.sourceGroupCatalogReader(authentication));
      if (!Array.isArray(groups)) return null;
      await this.sourceGroupCatalogWriter(groups);
      return groups;
    } catch (error) {
      this.logger.warn('[monitor] failed to refresh sub2api group catalog', error?.code || error?.message || error);
      return null;
    }
  }

  async refreshChannelMonitorSnapshots() {
    await this.refreshSourceGroupCatalog();
    const channelMonitors = await this.readChannelMonitors();
    if (!Array.isArray(channelMonitors)) return 0;
    return this.captureChannelMonitorGroupObservations(channelMonitors);
  }

  async refreshRuntimeSnapshots({ minIntervalMs = 0 } = {}) {
    if (this.runtimeRefreshPromise) return this.runtimeRefreshPromise;
    if (minIntervalMs > 0 && Date.now() - this.lastRuntimeRefreshAt < minIntervalMs) return 0;
    this.runtimeRefreshing = true;
    this.runtimeRefreshPromise = this.refreshRuntimeSnapshotsUnsafe().finally(() => {
      this.lastRuntimeRefreshAt = Date.now();
      this.runtimeRefreshing = false;
      this.runtimeRefreshPromise = null;
    });
    return this.runtimeRefreshPromise;
  }

  async refreshRuntimeSnapshotsUnsafe() {
    let queue = null;
    let users = [];
    try {
      if (this.runtimeStatusReader) {
        const result = await this.withSub2ApiAccessToken((authentication) => this.runtimeStatusReader(authentication));
        queue = result?.queue || null;
        users = Array.isArray(result?.users) ? result.users : [];
      }
    } catch (error) {
      await this.markSourceError('runtime_load', error);
      this.logger.warn('[runtime] failed to read Sub2API runtime API snapshot', error?.code || error?.message || error);
    }
    try {
      const redisRuntime = await this.runtimeConcurrencyReader?.();
      const redisUsers = Array.isArray(redisRuntime) ? redisRuntime : redisRuntime?.users;
      if (Array.isArray(redisUsers) && redisUsers.length) {
        const userMap = new Map(users.map((user) => [Number(user.sourceUserId), user]));
        for (const user of redisUsers) {
          const sourceUserId = Number(user?.sourceUserId);
          if (!Number.isSafeInteger(sourceUserId) || sourceUserId <= 0) continue;
          userMap.set(sourceUserId, {
            ...(userMap.get(sourceUserId) || {}),
            sourceUserId,
            currentConcurrency: Number(user.currentConcurrency || 0),
          });
        }
        users = [...userMap.values()];
      }
    } catch (error) {
      this.logger.warn('[runtime] failed to read Sub2API Redis concurrency snapshot', error?.code || error?.message || error);
    }
    if (!queue && !users.length) return 0;
    try {
      return await inTransaction(this.finopsPool, async (client) => {
        await this.cursor(client, 'runtime_load');
        if (queue) await client.query(`
          INSERT INTO ${this.schema}.runtime_queue_live(
            source_name,enabled,mode,worker_count,active_workers,idle_workers,
            queue_size,queue_length,queue_usage_percent,processed,errors,observed_at,synced_at)
          VALUES('sub2api_risk_control',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
          ON CONFLICT(source_name) DO UPDATE SET
            enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,worker_count=EXCLUDED.worker_count,
            active_workers=EXCLUDED.active_workers,idle_workers=EXCLUDED.idle_workers,
            queue_size=EXCLUDED.queue_size,queue_length=EXCLUDED.queue_length,
            queue_usage_percent=EXCLUDED.queue_usage_percent,processed=EXCLUDED.processed,
            errors=EXCLUDED.errors,observed_at=NOW(),synced_at=NOW()`,
        [
          Boolean(queue.enabled), queue.mode || '', Number(queue.workerCount || 0),
          Number(queue.activeWorkers || 0), Number(queue.idleWorkers || 0),
          Number(queue.queueSize || 0), Number(queue.queueLength || 0),
          Number(queue.queueUsagePercent || 0), Number(queue.processed || 0),
          Number(queue.errors || 0),
        ]);
        for (const user of users) {
          await client.query(`
            INSERT INTO ${this.schema}.user_concurrency_live(
              source_user_id,email,username,max_concurrency,current_concurrency,observed_at,synced_at)
            VALUES($1,$2,$3,$4,$5,NOW(),NOW())
            ON CONFLICT(source_user_id) DO UPDATE SET
              email=COALESCE(NULLIF(EXCLUDED.email,''),user_concurrency_live.email),
              username=COALESCE(NULLIF(EXCLUDED.username,''),user_concurrency_live.username),
              max_concurrency=CASE WHEN EXCLUDED.max_concurrency>0 THEN EXCLUDED.max_concurrency ELSE user_concurrency_live.max_concurrency END,
              current_concurrency=EXCLUDED.current_concurrency,observed_at=NOW(),synced_at=NOW()`,
          [
            user.sourceUserId, user.email || '', user.username || '',
            Number(user.maxConcurrency || 0), Number(user.currentConcurrency || 0),
          ]);
        }
        await this.markSuccess(client, 'runtime_load', null, users.length + 1);
        return users.length;
      });
    } catch (error) {
      await this.markSourceError('runtime_load', error);
      this.logger.warn('[runtime] failed to persist Sub2API runtime snapshots', error?.code || error?.message || error);
      return 0;
    }
  }

  async readLiveRuntime() {
    let queue = null;
    let users = [];
    let accounts = [];
    if (this.runtimeStatusReader) {
      try {
        const result = await this.withSub2ApiAccessToken((authentication) => this.runtimeStatusReader(authentication));
        queue = result?.queue || null;
        users = Array.isArray(result?.users) ? result.users : [];
      } catch (error) {
        this.logger.warn('[runtime] live Sub2API API read failed', error?.code || error?.message || error);
      }
    }
    try {
      const redisRuntime = await this.runtimeConcurrencyReader?.();
      const redisUsers = Array.isArray(redisRuntime) ? redisRuntime : redisRuntime?.users;
      accounts = Array.isArray(redisRuntime?.accounts) ? redisRuntime.accounts : [];
      if (Array.isArray(redisUsers)) {
        const userMap = new Map(users.map((user) => [Number(user.sourceUserId), user]));
        for (const user of redisUsers) {
          const sourceUserId = Number(user?.sourceUserId);
          if (!Number.isSafeInteger(sourceUserId) || sourceUserId <= 0) continue;
          userMap.set(sourceUserId, { ...(userMap.get(sourceUserId) || {}), ...user, sourceUserId });
        }
        users = [...userMap.values()];
      }
    } catch (error) {
      this.logger.warn('[runtime] live Sub2API Redis read failed', error?.code || error?.message || error);
    }
    return { queue, users, accounts, observedAt: new Date() };
  }

  async validateSourceSchema() {
    assertSourceUnitContract(this.config);
    const sourceColumns = this.config.subscriptionsEnabled
      ? Object.fromEntries(Object.entries(REQUIRED_SOURCE_COLUMNS).map(([table, columns]) => [
        table, [...columns, ...(OPTIONAL_SOURCE_COLUMNS[table] || [])],
      ]).concat([['user_subscriptions', OPTIONAL_SOURCE_COLUMNS.user_subscriptions]]))
      : REQUIRED_SOURCE_COLUMNS;
    const tables = Object.keys(sourceColumns);
    const result = await this.sourcePool.query(
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
    for (const [table, columns] of Object.entries(sourceColumns)) {
      for (const column of columns) if (!found.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
    if (missing.length) throw new Error(`ApiStation source schema is incompatible; missing: ${missing.join(', ')}`);
    const multiplierResult = await this.sourcePool.query(`
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
    const runtimeTick = async () => {
      try {
        const rows = await this.refreshRuntimeSnapshots();
        if (rows) await this.readCacheInvalidator?.();
      } catch (error) {
        this.logger.warn('[runtime] snapshot cycle failed', error?.message || error);
      } finally {
        if (this.runtimeTimer) {
          const interval = this.config.runtimeSnapshotIntervalSeconds || 10;
          this.runtimeTimer = setTimeout(runtimeTick, interval * 1000);
        }
      }
    };
    this.timer = setTimeout(tick, 50);
    this.runtimeTimer = setTimeout(runtimeTick, 100);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.timer = null;
    this.runtimeTimer = null;
  }

  async markSourceError(sourceName, error) {
    try {
      await this.finopsPool.query(`
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
      const historicalCostSnapshotRows = await inTransaction(
        this.finopsPool,
        (client) => this.freezePendingUsageCostSnapshots(client, 'historical_backfill'),
      );
      const historicalFixedCostSnapshotRows = await inTransaction(
        this.finopsPool,
        (client) => this.captureFixedCostDailySnapshots(client, 'historical_backfill'),
      );
      const paymentRows = await this.drain('payment_orders', () => this.syncPayments());
      const recentPaymentRows = await this.refreshRecentPayments();
      const redeemRows = await this.drain('redeem_codes', () => this.syncRedeemCodes());
      const affiliateRows = await this.drain('user_affiliate_ledger', () => this.syncAffiliateLedger());
      const auditRows = await this.drain('payment_audit_logs', () => this.syncPaymentAuditLogs());
      const subscriptionRows = this.config.subscriptionsEnabled
        ? await this.drain('user_subscriptions', () => this.syncSubscriptions())
        : 0;
      const usageRows = await this.drain('usage_logs', () => this.syncUsage());
      await this.refreshRecentUsage();
      const monitorObservationRows = await this.refreshChannelMonitorSnapshots();
      const runtimeSnapshotRows = await this.refreshRuntimeSnapshots();
      const liveUsageSnapshotResult = await inTransaction(
        this.finopsPool,
        async (client) => ({
          rows: await this.freezePendingUsageCostSnapshots(client, 'live_sync', { refreshOpenDay: true }),
          finalized: await this.finalizeUsageCostSnapshots(client),
        }),
      );
      const liveFixedCostSnapshotRows = await inTransaction(
        this.finopsPool,
        async (client) => {
          const rows = await this.captureFixedCostDailySnapshots(client, 'live_sync');
          await this.finalizeCostDailySnapshots(client);
          return rows;
        },
      );
      try {
        await this.reconcileRecentUsage();
        await this.reconcileWalletBalances();
      } catch (error) {
        await this.markSourceError('credit_reconciliation', error);
        throw error;
      }
      const result = {
        skipped: false, usageRows, paymentRows, recentPaymentRows, redeemRows, affiliateRows, auditRows, subscriptionRows,
        monitorObservationRows,
        runtimeSnapshotRows,
        historicalCostSnapshotRows, historicalFixedCostSnapshotRows,
        liveCostSnapshotRows: liveUsageSnapshotResult.rows,
        finalizedUsageCostSnapshotRows: liveUsageSnapshotResult.finalized,
        liveFixedCostSnapshotRows,
        durationMs: Date.now() - started,
      };
      try {
        await this.readCacheInvalidator?.();
      } catch (error) {
        this.logger.warn('[sync] failed to invalidate response cache', error?.message || error);
      }
      this.logger.info('[sync] cycle complete', result);
      return result;
    } finally {
      this.running = false;
    }
  }

  async syncDimensions() {
    try {
      const [users, accounts] = await Promise.all([
        this.sourcePool.query(`
          SELECT id,email,COALESCE(username,'') AS username,status,balance,
            COALESCE(total_recharged,0) AS total_recharged,deleted_at,updated_at
          FROM ${this.source}.users`),
        this.sourcePool.query(`
          SELECT id,name,platform,type,status,expires_at,deleted_at,updated_at,
            extra->'upstream_billing_probe' AS upstream_billing_probe
          FROM ${this.source}.accounts`),
      ]);
      await inTransaction(this.finopsPool, async (client) => {
        for (const row of users.rows) await client.query(`
          INSERT INTO ${this.schema}.dim_users(
            source_user_id,email,username,status,current_balance,total_recharged,balance_currency,
            source_deleted_at,source_updated_at,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,'CNY',$7,$8,NOW())
          ON CONFLICT(source_user_id) DO UPDATE SET
            email=EXCLUDED.email,username=EXCLUDED.username,status=EXCLUDED.status,
            current_balance=EXCLUDED.current_balance,total_recharged=EXCLUDED.total_recharged,
            source_deleted_at=EXCLUDED.source_deleted_at,source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`,
        [row.id, row.email, row.username, row.status, row.balance, row.total_recharged, row.deleted_at, row.updated_at]);
        for (const row of accounts.rows) {
          await client.query(`
            INSERT INTO ${this.schema}.dim_accounts(
              source_account_id,name,platform,account_type,status,expires_at,source_deleted_at,
              source_updated_at,synced_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
            ON CONFLICT(source_account_id) DO UPDATE SET
              name=EXCLUDED.name,platform=EXCLUDED.platform,account_type=EXCLUDED.account_type,
              status=EXCLUDED.status,expires_at=EXCLUDED.expires_at,source_deleted_at=EXCLUDED.source_deleted_at,
              source_updated_at=EXCLUDED.source_updated_at,synced_at=NOW()`,
          [row.id, row.name, row.platform, row.type, row.status, row.expires_at, row.deleted_at, row.updated_at]);
          const rateObservation = await this.upsertUpstreamBillingSnapshot(client, row.id, row.upstream_billing_probe);
          await this.upsertAccountDailySnapshot(client, row, rateObservation);
        }
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

  async captureMonitorGroupObservations(channelMonitors = null) {
    if (!Array.isArray(channelMonitors)) return 0;
    return this.captureChannelMonitorGroupObservations(channelMonitors);
  }

  async captureChannelMonitorGroupObservations(channelMonitors) {
    const configured = await this.finopsPool.query(`
      SELECT g.id,g.name AS monitor_group_name,COALESCE(c.name,'') AS source_group_name
      FROM ${this.schema}.monitor_groups g
      LEFT JOIN ${this.schema}.source_group_catalog c ON c.source_group_id=g.source_group_id
      WHERE g.enabled
      ORDER BY g.id`);
    if (!configured.rowCount) return 0;
    return inTransaction(this.finopsPool, async (client) => {
      for (const group of configured.rows) {
        const groupNames = new Set([
          normalizedGroupName(group.monitor_group_name),
          normalizedGroupName(group.source_group_name),
        ].filter(Boolean));
        const monitors = channelMonitors.filter((monitor) => (
          monitor?.enabled !== false && groupNames.has(normalizedGroupName(monitor.groupName))
        ));
        const summary = summarizeChannelMonitorGroup(monitors);
        await client.query(`
          INSERT INTO ${this.schema}.monitor_group_observations(
            monitor_group_id,status,available_account_count,total_account_count,
            group_multiplier,user_multiplier,effective_multiplier,average_latency_ms,
            average_ping_latency_ms,source_availability_percent,observation_source)
          VALUES($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,$7,'sub2api_channel_monitor')`,
        [
          group.id,
          summary.status,
          summary.availableCount,
          summary.totalCount,
          summary.averageLatencyMs,
          summary.averagePingLatencyMs,
          summary.availabilityPercent,
        ]);
      }
      return configured.rowCount;
    });
  }

  async upsertUpstreamBillingSnapshot(client, accountId, rawSnapshot) {
    const snapshot = normalizeUpstreamBillingSnapshot(rawSnapshot);
    if (!snapshot) return { id: null, snapshot: null };
    await client.query(`
      INSERT INTO ${this.schema}.upstream_billing_snapshots(
        source_account_id,snapshot_key,status,billing_scope,observed_at,received_at,fresh_until,
        last_attempt_at,next_probe_at,failure_count,http_status,last_error,
        group_rate_multiplier,user_rate_multiplier,resolved_rate_multiplier,effective_rate_multiplier,
        peak_rate_enabled,peak_rate_multiplier,applied_peak_multiplier,timezone,snapshot_data,synced_at)
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,NOW()
      )
      ON CONFLICT(source_account_id,snapshot_key) DO UPDATE SET
        status=EXCLUDED.status,billing_scope=EXCLUDED.billing_scope,observed_at=EXCLUDED.observed_at,
        received_at=EXCLUDED.received_at,fresh_until=EXCLUDED.fresh_until,last_attempt_at=EXCLUDED.last_attempt_at,
        next_probe_at=EXCLUDED.next_probe_at,failure_count=EXCLUDED.failure_count,http_status=EXCLUDED.http_status,
        last_error=EXCLUDED.last_error,group_rate_multiplier=EXCLUDED.group_rate_multiplier,
        user_rate_multiplier=EXCLUDED.user_rate_multiplier,resolved_rate_multiplier=EXCLUDED.resolved_rate_multiplier,
        effective_rate_multiplier=EXCLUDED.effective_rate_multiplier,peak_rate_enabled=EXCLUDED.peak_rate_enabled,
        peak_rate_multiplier=EXCLUDED.peak_rate_multiplier,applied_peak_multiplier=EXCLUDED.applied_peak_multiplier,
        timezone=EXCLUDED.timezone,snapshot_data=EXCLUDED.snapshot_data,synced_at=NOW()`,
    [
      accountId, snapshot.snapshotKey, snapshot.status, snapshot.billingScope, snapshot.observedAt,
      snapshot.receivedAt, snapshot.freshUntil, snapshot.lastAttemptAt, snapshot.nextProbeAt,
      snapshot.failureCount, snapshot.httpStatus, snapshot.lastError, snapshot.groupRateMultiplier,
      snapshot.userRateMultiplier, snapshot.resolvedRateMultiplier, snapshot.effectiveRateMultiplier,
      snapshot.peakRateEnabled, snapshot.peakRateMultiplier, snapshot.appliedPeakMultiplier, snapshot.timezone,
      JSON.stringify(snapshot.data),
    ]);
    const observation = await client.query(`
      INSERT INTO ${this.schema}.account_rate_observations(
        source_account_id,observation_key,source_kind,status,billing_scope,observed_at,received_at,
        fresh_until,last_attempt_at,next_probe_at,failure_count,http_status,last_error,
        group_rate_multiplier,user_rate_multiplier,resolved_rate_multiplier,effective_rate_multiplier,
        peak_rate_enabled,peak_rate_multiplier,applied_peak_multiplier,timezone,snapshot_data)
      VALUES(
        $1,$2,'sub2api_cached_probe',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT(source_account_id,observation_key) DO NOTHING
      RETURNING id`,
    [
      accountId, snapshot.snapshotKey, snapshot.status, snapshot.billingScope, snapshot.observedAt,
      snapshot.receivedAt, snapshot.freshUntil, snapshot.lastAttemptAt, snapshot.nextProbeAt,
      snapshot.failureCount, snapshot.httpStatus, snapshot.lastError, snapshot.groupRateMultiplier,
      snapshot.userRateMultiplier, snapshot.resolvedRateMultiplier, snapshot.effectiveRateMultiplier,
      snapshot.peakRateEnabled, snapshot.peakRateMultiplier, snapshot.appliedPeakMultiplier, snapshot.timezone,
      JSON.stringify(snapshot.data),
    ]);
    let id = observation.rows[0]?.id || null;
    if (!id) {
      const existing = await client.query(`
        SELECT id
        FROM ${this.schema}.account_rate_observations
        WHERE source_account_id=$1 AND observation_key=$2
        LIMIT 1`, [accountId, snapshot.snapshotKey]);
      id = existing.rows[0]?.id || null;
    }
    return { id, snapshot };
  }

  async upsertAccountDailySnapshot(client, sourceAccount, rateObservation) {
    const day = dateKey(new Date(), this.config.timezone || 'UTC');
    const snapshot = rateObservation?.snapshot || null;
    const observationId = rateObservation?.id || null;
    const rateStatus = snapshot?.status || 'unknown';
    const effectiveRate = snapshot?.effectiveRateMultiplier ?? null;
    const isAvailable = sourceAccount.deleted_at == null && sourceAccount.status === 'active';
    const existingResult = await client.query(`
      SELECT *
      FROM ${this.schema}.account_daily_snapshots
      WHERE day=$1 AND source_account_id=$2
      FOR UPDATE`, [day, sourceAccount.id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query(`
        INSERT INTO ${this.schema}.account_daily_snapshots(
          day,source_account_id,name,platform,account_type,status,expires_at,source_deleted_at,
          source_updated_at,is_available,rate_observation_id,first_rate_observation_id,
          rate_status,effective_rate_multiplier,rate_change_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,0)`,
      [
        day, sourceAccount.id, sourceAccount.name || '', sourceAccount.platform || '',
        sourceAccount.type || '', sourceAccount.status || '', sourceAccount.expires_at || null,
        sourceAccount.deleted_at || null, sourceAccount.updated_at || null, isAvailable,
        observationId, rateStatus, effectiveRate,
      ]);
      return;
    }

    const rateChanged = effectiveRate !== null
      && (existing.effective_rate_multiplier === null
        || !decimal(existing.effective_rate_multiplier).eq(decimal(effectiveRate)));
    const stateChanged = existing.name !== (sourceAccount.name || '')
      || existing.platform !== (sourceAccount.platform || '')
      || existing.account_type !== (sourceAccount.type || '')
      || existing.status !== (sourceAccount.status || '')
      || new Date(existing.expires_at || 0).getTime() !== new Date(sourceAccount.expires_at || 0).getTime()
      || new Date(existing.source_deleted_at || 0).getTime() !== new Date(sourceAccount.deleted_at || 0).getTime()
      || Boolean(existing.is_available) !== isAvailable
      || (snapshot && existing.rate_status !== rateStatus)
      || rateChanged;
    await client.query(`
      UPDATE ${this.schema}.account_daily_snapshots
      SET name=$3,platform=$4,account_type=$5,status=$6,expires_at=$7,source_deleted_at=$8,
          source_updated_at=$9,is_available=$10,
          rate_observation_id=COALESCE($11,rate_observation_id),
          first_rate_observation_id=COALESCE(first_rate_observation_id,$11),
          rate_status=CASE WHEN $11 IS NULL THEN rate_status ELSE $12 END,
          effective_rate_multiplier=CASE WHEN $11 IS NULL THEN effective_rate_multiplier ELSE $13 END,
          rate_change_count=rate_change_count+$14,
          last_state_changed_at=CASE WHEN $15::boolean THEN NOW() ELSE last_state_changed_at END
      WHERE day=$1 AND source_account_id=$2`,
    [
      day, sourceAccount.id, sourceAccount.name || '', sourceAccount.platform || '',
      sourceAccount.type || '', sourceAccount.status || '', sourceAccount.expires_at || null,
      sourceAccount.deleted_at || null, sourceAccount.updated_at || null, isAvailable,
      observationId, rateStatus, effectiveRate, rateChanged ? 1 : 0, stateChanged,
    ]);
  }

  async freezePendingUsageCostSnapshots(client, origin, { refreshOpenDay = false } = {}) {
    let total = 0;
    for (;;) {
      const pending = await client.query(`
        WITH pending_usage AS MATERIALIZED (
          SELECT f.*
          FROM ${this.schema}.fact_usage_events f
          LEFT JOIN ${this.schema}.fact_usage_cost_snapshots current_snapshot
            ON current_snapshot.source_usage_id=f.source_usage_id
          LEFT JOIN ${this.schema}.usage_cost_reprice_queue reprice
            ON reprice.source_usage_id=f.source_usage_id
          WHERE current_snapshot.source_usage_id IS NULL
            OR (
              $2::boolean
              AND reprice.source_usage_id IS NOT NULL
              AND (
                current_snapshot.finalized=FALSE
                OR current_snapshot.cost_status NOT IN ('priced','free','fixed_cost')
              )
            )
          ORDER BY f.occurred_at,f.source_usage_id
          LIMIT $1
        )
        SELECT
          f.source_usage_id,f.source_account_id,f.source_user_id,f.source_group_id,f.model,
          f.occurred_at,f.user_charge_cny,f.standard_cost_usd_reference,
          f.user_rate_multiplier AS source_selling_multiplier,
          f.account_rate_multiplier AS source_account_multiplier,
          COALESCE(rule.cost_mode,rule_profile.cost_mode,account_profile.cost_mode,
            CASE
              WHEN account_profile.cost_type='free' THEN 'free'
              WHEN fixed_period.id IS NOT NULL THEN 'fixed_purchase'
              WHEN COALESCE(supplier_rate.rate_multiplier,supplier_key.rate_multiplier) IS NOT NULL
                AND COALESCE(supplier_rate.rate_multiplier,supplier_key.rate_multiplier)>=0
                THEN 'probe_multiplier'
              -- Legacy unlinked accounts may still use a confirmed, read-only
              -- upstream probe when no supplier-key multiplier is available.
              WHEN observation.status='ok'
                AND observation.effective_rate_multiplier>=0
                AND observation.fresh_until>f.occurred_at THEN 'probe_multiplier'
              ELSE 'unconfigured'
            END) AS configured_cost_mode,
          COALESCE(rule.basis_mode,rule_profile.basis_mode,account_profile.basis_mode,'revenue_backsolve') AS basis_mode,
          NULLIF(f.user_rate_multiplier,0) AS selling_multiplier,
          COALESCE(rule.upstream_multiplier,rule_profile.variable_multiplier,account_profile.variable_multiplier)
            AS manual_upstream_multiplier,
          COALESCE(
            rule.cny_per_reference_unit,
            rule_profile.cny_per_reference_unit,
            account_profile.cny_per_reference_unit
          ) AS cny_per_reference_unit,
          COALESCE(rule.cost_profile_id,rule_profile.id,account_profile.id,fixed_period.cost_profile_id) AS cost_profile_id,
          rule.id AS account_cost_rule_id,
          COALESCE(rule.supplier_key_id,supplier_link.supplier_key_id) AS configured_supplier_key_id,
          supplier_key.rate_multiplier AS supplier_inventory_multiplier,
          supplier_rate.id AS supplier_rate_observation_id,
          supplier_rate.rate_multiplier AS supplier_observed_multiplier,
          NULL::bigint AS selling_rate_rule_id,
          fixed_period.id AS fixed_period_id,
          observation.id AS rate_observation_id,
          observation.status AS observation_status,
          observation.source_kind AS observation_source_kind,
          observation.fresh_until AS observation_fresh_until,
          observation.resolved_rate_multiplier AS observed_resolved_multiplier,
          observation.effective_rate_multiplier AS observed_upstream_multiplier,
          observation.peak_rate_enabled AS observed_peak_enabled,
          observation.peak_rate_multiplier AS observed_peak_multiplier,
          observation.timezone AS observed_timezone,
          observation.snapshot_data->>'peak_start' AS observed_peak_start,
          observation.snapshot_data->>'peak_end' AS observed_peak_end
        FROM pending_usage f
        LEFT JOIN ${this.schema}.dim_accounts account
          ON account.source_account_id=f.source_account_id
        LEFT JOIN ${this.schema}.cost_profiles account_profile
          ON account_profile.id=account.cost_profile_id
        LEFT JOIN LATERAL (
          SELECT r.*
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=f.source_account_id
            AND r.status IN ('active','superseded')
            AND r.effective_from <= f.occurred_at
            AND (r.effective_to IS NULL OR r.effective_to > f.occurred_at)
          ORDER BY r.effective_from DESC,r.id DESC
          LIMIT 1
        ) rule ON TRUE
        LEFT JOIN ${this.schema}.cost_profiles rule_profile
          ON rule_profile.id=rule.cost_profile_id
        LEFT JOIN LATERAL (
          SELECT p.id,p.cost_profile_id
          FROM ${this.schema}.account_cost_periods p
          WHERE p.source_account_id=f.source_account_id
            AND p.status='active'
            AND p.effective_from <= f.occurred_at
            AND p.effective_to > f.occurred_at
          ORDER BY p.effective_from DESC,p.id DESC
          LIMIT 1
        ) fixed_period ON TRUE
        LEFT JOIN ${this.schema}.supplier_account_links supplier_link
          ON supplier_link.source_account_id=f.source_account_id
        LEFT JOIN ${this.schema}.supplier_keys supplier_key
          ON supplier_key.id=COALESCE(rule.supplier_key_id,supplier_link.supplier_key_id)
          AND supplier_key.status='active'
          AND supplier_key.removed_at IS NULL
        LEFT JOIN LATERAL (
          SELECT key_rate.id,key_rate.rate_multiplier,key_rate.observed_at
          FROM ${this.schema}.supplier_key_observations key_rate
          WHERE key_rate.supplier_key_id=supplier_key.id
            AND key_rate.status='active'
          ORDER BY
            CASE WHEN key_rate.observed_at<=f.occurred_at THEN 0 ELSE 1 END,
            CASE WHEN key_rate.observed_at<=f.occurred_at THEN key_rate.observed_at END DESC,
            CASE WHEN key_rate.observed_at>f.occurred_at THEN key_rate.observed_at END ASC,
            key_rate.id DESC
          LIMIT 1
        ) supplier_rate ON TRUE
        LEFT JOIN LATERAL (
          SELECT o.id,o.status,o.source_kind,o.resolved_rate_multiplier,o.effective_rate_multiplier,
                 o.peak_rate_enabled,o.peak_rate_multiplier,o.timezone,o.snapshot_data,o.fresh_until
          FROM ${this.schema}.account_rate_observations o
          WHERE o.source_account_id=f.source_account_id
            AND (
              COALESCE(rule.supplier_key_id,supplier_link.supplier_key_id) IS NULL
              OR o.supplier_key_id=COALESCE(rule.supplier_key_id,supplier_link.supplier_key_id)
            )
            AND GREATEST(
              COALESCE(o.observed_at,'-infinity'::timestamptz),
              COALESCE(o.received_at,'-infinity'::timestamptz),
              COALESCE(o.last_attempt_at,'-infinity'::timestamptz),
              COALESCE(o.captured_at,'-infinity'::timestamptz)
            ) <= f.occurred_at
          ORDER BY GREATEST(
            COALESCE(o.observed_at,'-infinity'::timestamptz),
            COALESCE(o.received_at,'-infinity'::timestamptz),
            COALESCE(o.last_attempt_at,'-infinity'::timestamptz),
            COALESCE(o.captured_at,'-infinity'::timestamptz)
          ) DESC,o.id DESC
          LIMIT 1
        ) observation ON TRUE
        ORDER BY f.occurred_at,f.source_usage_id
        `, [
        COST_SNAPSHOT_BATCH_SIZE,
        refreshOpenDay,
      ]);
      if (!pending.rowCount) break;

      const rows = pending.rows.map((row) => {
        let costMode = row.configured_cost_mode || 'unconfigured';
        let upstreamMultiplier = null;
        let upstreamSource = '';
        if (costMode === 'manual_multiplier') {
          upstreamMultiplier = row.manual_upstream_multiplier;
          upstreamSource = upstreamMultiplier === null || upstreamMultiplier === undefined ? '' : 'manual_rule';
        } else if (costMode === 'probe_multiplier') {
          const supplierKeyMultiplier = row.configured_supplier_key_id === null
            || row.configured_supplier_key_id === undefined
            ? null
            : row.supplier_observed_multiplier ?? row.supplier_inventory_multiplier;
          const occurredAt = new Date(row.occurred_at).getTime();
          const freshUntil = new Date(row.observation_fresh_until || 0).getTime();
          const observationFresh = row.observation_status === 'ok'
            && Number.isFinite(occurredAt) && Number.isFinite(freshUntil) && freshUntil > occurredAt;
          const observedMultiplier = observationFresh ? effectiveObservedMultiplierAt({
            resolvedRateMultiplier: row.observed_resolved_multiplier,
            effectiveRateMultiplier: row.observed_upstream_multiplier,
            peakRateEnabled: Boolean(row.observed_peak_enabled),
            peakStart: row.observed_peak_start,
            peakEnd: row.observed_peak_end,
            peakRateMultiplier: row.observed_peak_multiplier,
            timezone: row.observed_timezone,
          }, row.occurred_at) : null;
          if (supplierKeyMultiplier !== null && supplierKeyMultiplier !== undefined) {
            upstreamMultiplier = supplierKeyMultiplier;
            upstreamSource = row.supplier_rate_observation_id
              ? 'supplier_key_history' : 'supplier_key_inventory';
          } else if (observedMultiplier !== null) {
            upstreamMultiplier = observedMultiplier;
            upstreamSource = row.observation_source_kind === 'supplier_direct_probe'
              ? 'supplier_direct_probe' : 'probe_observation';
          } else if (
            !row.configured_supplier_key_id
            && row.source_account_multiplier !== null
            && row.source_account_multiplier !== undefined
          ) {
            upstreamMultiplier = row.source_account_multiplier;
            upstreamSource = 'usage_log_snapshot';
          }
        }
        if (upstreamMultiplier !== null && upstreamMultiplier !== undefined && decimal(upstreamMultiplier).eq(0)) {
          costMode = 'free';
        }
        const calculation = calculateMultiplierCostCny({
          mode: costMode,
          basisMode: row.basis_mode,
          userChargeCny: row.user_charge_cny,
          standardCostReference: row.standard_cost_usd_reference,
          sourceSellingMultiplier: row.selling_multiplier,
          upstreamMultiplier,
          cnyPerReferenceUnit: row.cny_per_reference_unit,
        });
        return {
          source_usage_id: row.source_usage_id,
          source_account_id: row.source_account_id,
          source_user_id: row.source_user_id,
          source_group_id: row.source_group_id,
          model: row.model || '',
          occurred_at: row.occurred_at,
          user_charge_cny: numeric(row.user_charge_cny),
          standard_cost_usd_reference: numeric(row.standard_cost_usd_reference),
          source_selling_multiplier: row.source_selling_multiplier ?? null,
          source_account_multiplier: row.source_account_multiplier ?? null,
          cost_mode: costMode,
          basis_mode: row.basis_mode || 'revenue_backsolve',
          cost_profile_id: row.cost_profile_id || null,
          account_cost_rule_id: row.account_cost_rule_id || null,
          selling_rate_rule_id: row.selling_rate_rule_id || null,
          rate_observation_id: upstreamSource === 'probe_observation' || upstreamSource === 'supplier_direct_probe'
            ? row.rate_observation_id || null : null,
          selling_multiplier: row.selling_multiplier ?? null,
          upstream_multiplier: upstreamMultiplier,
          cny_per_reference_unit: row.cny_per_reference_unit ?? null,
          upstream_multiplier_source: upstreamSource,
          cost_status: calculation.status,
          calculated_cost_cny: calculation.costCny,
          snapshot_origin: origin,
          pricing_version: 4,
        };
      });
      for (let offset = 0; offset < rows.length; offset += MAX_COST_SNAPSHOT_ROWS_PER_INSERT) {
        const chunk = rows.slice(offset, offset + MAX_COST_SNAPSHOT_ROWS_PER_INSERT);
        const params = [];
        for (const row of chunk) {
          params.push(
            row.source_usage_id, row.source_account_id, row.source_user_id, row.source_group_id,
            row.model, row.occurred_at, row.user_charge_cny, row.standard_cost_usd_reference,
            row.source_selling_multiplier, row.source_account_multiplier, row.cost_mode, row.basis_mode,
            row.cost_profile_id, row.account_cost_rule_id, row.selling_rate_rule_id, row.rate_observation_id,
            row.selling_multiplier, row.upstream_multiplier, row.cny_per_reference_unit,
            row.upstream_multiplier_source, row.cost_status, row.calculated_cost_cny,
            row.snapshot_origin, row.pricing_version,
          );
        }
        const inserted = await client.query(`
          INSERT INTO ${this.schema}.fact_usage_cost_snapshots(
            source_usage_id,source_account_id,source_user_id,source_group_id,model,occurred_at,
            user_charge_cny,standard_cost_usd_reference,source_selling_multiplier,
            source_account_multiplier,cost_mode,basis_mode,cost_profile_id,account_cost_rule_id,
            selling_rate_rule_id,rate_observation_id,selling_multiplier,upstream_multiplier,cny_per_reference_unit,
            upstream_multiplier_source,cost_status,calculated_cost_cny,snapshot_origin,pricing_version)
          VALUES ${valuesPlaceholders(chunk.length, COST_SNAPSHOT_COLUMN_COUNT)}
          ${refreshOpenDay ? `ON CONFLICT(source_usage_id) DO UPDATE SET
            source_account_id=EXCLUDED.source_account_id,
            source_user_id=EXCLUDED.source_user_id,
            source_group_id=EXCLUDED.source_group_id,
            model=EXCLUDED.model,
            occurred_at=EXCLUDED.occurred_at,
            user_charge_cny=EXCLUDED.user_charge_cny,
            standard_cost_usd_reference=EXCLUDED.standard_cost_usd_reference,
            source_selling_multiplier=EXCLUDED.source_selling_multiplier,
            source_account_multiplier=EXCLUDED.source_account_multiplier,
            cost_mode=EXCLUDED.cost_mode,
            basis_mode=EXCLUDED.basis_mode,
            cost_profile_id=EXCLUDED.cost_profile_id,
            account_cost_rule_id=EXCLUDED.account_cost_rule_id,
            selling_rate_rule_id=EXCLUDED.selling_rate_rule_id,
            rate_observation_id=EXCLUDED.rate_observation_id,
            selling_multiplier=EXCLUDED.selling_multiplier,
            upstream_multiplier=EXCLUDED.upstream_multiplier,
            cny_per_reference_unit=EXCLUDED.cny_per_reference_unit,
            upstream_multiplier_source=EXCLUDED.upstream_multiplier_source,
            cost_status=EXCLUDED.cost_status,
            calculated_cost_cny=EXCLUDED.calculated_cost_cny,
            snapshot_origin=EXCLUDED.snapshot_origin,
            pricing_version=EXCLUDED.pricing_version,
            frozen_at=clock_timestamp(),
            finalized=fact_usage_cost_snapshots.finalized,
            finalized_at=fact_usage_cost_snapshots.finalized_at
          WHERE NOT fact_usage_cost_snapshots.finalized
             OR fact_usage_cost_snapshots.cost_status NOT IN ('priced','free','fixed_cost')`
    : 'ON CONFLICT(source_usage_id) DO NOTHING'}`, params);
        await client.query(`
          DELETE FROM ${this.schema}.usage_cost_reprice_queue
          WHERE source_usage_id=ANY($1::bigint[])`, [chunk.map((row) => row.source_usage_id)]);
        total += inserted.rowCount;
      }
    }
    return total;
  }

  async refreshQueuedUsageCosts(origin = 'live_sync') {
    if (this.running) return 0;
    if (this.costRefreshPromise) return this.costRefreshPromise;
    this.costRefreshPromise = inTransaction(
      this.finopsPool,
      (client) => this.freezePendingUsageCostSnapshots(client, origin, { refreshOpenDay: true }),
    ).finally(() => {
      this.costRefreshPromise = null;
    });
    return this.costRefreshPromise;
  }

  async finalizeUsageCostSnapshots(client) {
    const result = await client.query(`
      UPDATE ${this.schema}.fact_usage_cost_snapshots
      SET finalized=TRUE,finalized_at=COALESCE(finalized_at,NOW())
      WHERE finalized=FALSE
        AND occurred_at < (
          date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
          - (($2::int - 1) * INTERVAL '1 day')
        )`, [this.config.timezone || 'UTC', USAGE_COST_SNAPSHOT_OPEN_DAYS]);
    return result.rowCount;
  }

  async captureFixedCostDailySnapshots(client, origin) {
    const result = await client.query(`
      WITH eligible_periods AS (
        SELECT
          p.id,p.source_account_id,p.cost_profile_id,p.effective_from,p.effective_to,p.status,
          COALESCE(p.allocated_cost_cny,p.base_amount+p.fee_amount+p.tax_amount) AS period_total_cost_cny,
          COALESCE(profile.cost_type,'prepaid') AS cost_type,
          COALESCE(profile.allocation_method,'standard_cost_weight') AS allocation_method,
          COALESCE(
            rule.cost_mode,
            profile.cost_mode,
            CASE WHEN profile.cost_type='free' THEN 'free' ELSE 'fixed_purchase' END
          ) AS resolved_cost_mode
        FROM ${this.schema}.account_cost_periods p
        LEFT JOIN ${this.schema}.cost_profiles profile ON profile.id=p.cost_profile_id
        LEFT JOIN LATERAL (
          SELECT r.cost_mode
          FROM ${this.schema}.account_cost_rules r
          WHERE r.source_account_id=p.source_account_id
            AND r.status IN ('active','superseded')
            AND r.effective_from <= p.effective_from
            AND (r.effective_to IS NULL OR r.effective_to > p.effective_from)
          ORDER BY r.effective_from DESC,r.id DESC
          LIMIT 1
        ) rule ON TRUE
        WHERE p.status='active'
          AND COALESCE(
            rule.cost_mode,
            profile.cost_mode,
            CASE WHEN profile.cost_type='free' THEN 'free' ELSE 'fixed_purchase' END
          )='fixed_purchase'
      ), daily AS (
        SELECT
          p.*,
          gs::date AS day,
          (gs AT TIME ZONE $1) AS day_started_at,
          ((gs + INTERVAL '1 day') AT TIME ZONE $1) AS day_ended_at
        FROM eligible_periods p
        CROSS JOIN LATERAL generate_series(
          date_trunc('day',p.effective_from AT TIME ZONE $1),
          date_trunc('day',(p.effective_to - INTERVAL '1 microsecond') AT TIME ZONE $1),
          INTERVAL '1 day'
        ) gs
      ), apportioned AS (
        SELECT
          d.*,
          GREATEST(d.effective_from,d.day_started_at) AS overlap_started_at,
          LEAST(d.effective_to,d.day_ended_at) AS overlap_ended_at
        FROM daily d
      )
      INSERT INTO ${this.schema}.account_cost_daily_snapshots(
        day,account_cost_period_id,source_account_id,day_started_at,day_ended_at,
        cost_profile_id,cost_type,cost_mode,allocation_method,period_total_cost_cny,
        daily_cost_cny,effective_from,effective_to,status,snapshot_origin)
      SELECT
        day,id,source_account_id,day_started_at,day_ended_at,
        cost_profile_id,cost_type,'fixed_purchase',allocation_method,period_total_cost_cny,
        CASE
          WHEN effective_to > effective_from
            THEN period_total_cost_cny
              * EXTRACT(EPOCH FROM (overlap_ended_at-overlap_started_at))
              / EXTRACT(EPOCH FROM (effective_to-effective_from))
          ELSE 0
        END,
        effective_from,effective_to,status,$2
      FROM apportioned
      WHERE overlap_ended_at > overlap_started_at
      ON CONFLICT(day,account_cost_period_id) DO UPDATE SET
        source_account_id=EXCLUDED.source_account_id,
        day_started_at=EXCLUDED.day_started_at,day_ended_at=EXCLUDED.day_ended_at,
        cost_profile_id=EXCLUDED.cost_profile_id,cost_type=EXCLUDED.cost_type,
        cost_mode=EXCLUDED.cost_mode,allocation_method=EXCLUDED.allocation_method,
        period_total_cost_cny=EXCLUDED.period_total_cost_cny,
        daily_cost_cny=EXCLUDED.daily_cost_cny,effective_from=EXCLUDED.effective_from,
        effective_to=EXCLUDED.effective_to,status=EXCLUDED.status,
        snapshot_origin=EXCLUDED.snapshot_origin,updated_at=NOW()
      WHERE NOT account_cost_daily_snapshots.finalized
      RETURNING day,account_cost_period_id`,
    [this.config.timezone || 'UTC', origin]);
    return result.rowCount;
  }

  async finalizeCostDailySnapshots(client) {
    const today = dateKey(new Date(), this.config.timezone || 'UTC');
    const result = await client.query(`
      UPDATE ${this.schema}.account_cost_daily_snapshots
      SET finalized=TRUE,finalized_at=COALESCE(finalized_at,NOW()),updated_at=NOW()
      WHERE finalized=FALSE
        AND day < ($1::date - ($2::int * INTERVAL '1 day'))`,
    [today, COST_SNAPSHOT_OPEN_DAYS]);
    return result.rowCount;
  }

  async readCursor(sourceName) {
    const result = await this.finopsPool.query(
      `SELECT cursor_time,cursor_id FROM ${this.schema}.sync_cursors WHERE source_name=$1`,
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
    const cursor = await this.readCursor('usage_logs');
    const billingColumns = this.config.subscriptionsEnabled
      ? 'COALESCE(billing_type,0) AS billing_type,subscription_id,'
      : '0::smallint AS billing_type,NULL::bigint AS subscription_id,';
    const sourceRows = await this.sourcePool.query(`
      SELECT id AS source_usage_id,
        COALESCE(request_id,'usage:'||id::text) AS request_id,
        user_id AS source_user_id,api_key_id AS source_api_key_id,
        account_id AS source_account_id,COALESCE(group_id,0) AS source_group_id,
        COALESCE(channel_id,0) AS source_channel_id,model,
        COALESCE(requested_model,'') AS requested_model,COALESCE(upstream_model,'') AS upstream_model,
        COALESCE(billing_mode,'token') AS billing_mode,${billingColumns}
        input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
        total_cost AS standard_cost_usd_reference,actual_cost AS user_charge_cny,
        COALESCE(rate_multiplier,1) AS user_rate_multiplier,
        account_rate_multiplier,
        duration_ms,first_token_ms,created_at AS occurred_at
      FROM ${this.source}.usage_logs
      WHERE (created_at,id)>($1,$2)
      ORDER BY created_at,id LIMIT $3`,
    [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'usage_logs');
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
        WITH upserted AS (
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
          synced_at=NOW()
        WHERE ROW(
          fact_usage_events.request_id,fact_usage_events.source_user_id,
          fact_usage_events.source_api_key_id,fact_usage_events.source_account_id,
          fact_usage_events.source_group_id,fact_usage_events.source_channel_id,
          fact_usage_events.model,fact_usage_events.requested_model,fact_usage_events.upstream_model,
          fact_usage_events.billing_mode,fact_usage_events.billing_type,fact_usage_events.subscription_id,
          fact_usage_events.input_tokens,fact_usage_events.output_tokens,
          fact_usage_events.cache_creation_tokens,fact_usage_events.cache_read_tokens,
          fact_usage_events.user_rate_multiplier,fact_usage_events.account_rate_multiplier,
          fact_usage_events.duration_ms,fact_usage_events.first_token_ms,fact_usage_events.occurred_at,
          fact_usage_events.standard_cost_usd_reference,fact_usage_events.user_charge_cny
        ) IS DISTINCT FROM ROW(
          EXCLUDED.request_id,EXCLUDED.source_user_id,
          EXCLUDED.source_api_key_id,EXCLUDED.source_account_id,
          EXCLUDED.source_group_id,EXCLUDED.source_channel_id,
          EXCLUDED.model,EXCLUDED.requested_model,EXCLUDED.upstream_model,
          EXCLUDED.billing_mode,EXCLUDED.billing_type,EXCLUDED.subscription_id,
          EXCLUDED.input_tokens,EXCLUDED.output_tokens,
          EXCLUDED.cache_creation_tokens,EXCLUDED.cache_read_tokens,
          EXCLUDED.user_rate_multiplier,EXCLUDED.account_rate_multiplier,
          EXCLUDED.duration_ms,EXCLUDED.first_token_ms,EXCLUDED.occurred_at,
          EXCLUDED.standard_cost_usd_reference,EXCLUDED.user_charge_cny
        )
        RETURNING source_usage_id
        )
        INSERT INTO ${this.schema}.usage_cost_reprice_queue(source_usage_id,reason,queued_at)
        SELECT source_usage_id,'usage_changed',NOW() FROM upserted
        ON CONFLICT(source_usage_id) DO UPDATE SET
          reason=EXCLUDED.reason,queued_at=EXCLUDED.queued_at`, params);
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
        COALESCE(NULLIF(BTRIM(model),''),NULLIF(BTRIM(requested_model),''),
          NULLIF(BTRIM(upstream_model),''),'未标注模型'),
        billing_mode,billing_type,COUNT(*),SUM(input_tokens),SUM(output_tokens),SUM(cache_creation_tokens),SUM(cache_read_tokens),
        SUM(standard_cost_usd_reference),SUM(user_charge_cny),SUM(recognized_revenue_cny)
      FROM ${this.schema}.fact_usage_events
      WHERE (occurred_at AT TIME ZONE $2)::date=ANY($1::date[])
      GROUP BY (occurred_at AT TIME ZONE $2)::date,source_user_id,source_api_key_id,source_account_id,source_group_id,
        COALESCE(NULLIF(BTRIM(model),''),NULLIF(BTRIM(requested_model),''),
          NULLIF(BTRIM(upstream_model),''),'未标注模型'),
        billing_mode,billing_type`,
    [days, this.config.timezone]);
  }

  async refreshRecentUsage() {
    if (!this.config.syncLookbackSeconds) return;
    const since = new Date(Date.now() - this.config.syncLookbackSeconds * 1000);
    const billingColumns = this.config.subscriptionsEnabled
      ? 'COALESCE(billing_type,0) AS billing_type,subscription_id,'
      : '0::smallint AS billing_type,NULL::bigint AS subscription_id,';
    const rows = await this.sourcePool.query(`
      SELECT id AS source_usage_id,COALESCE(request_id,'usage:'||id::text) AS request_id,
        user_id AS source_user_id,api_key_id AS source_api_key_id,account_id AS source_account_id,
        COALESCE(group_id,0) AS source_group_id,COALESCE(channel_id,0) AS source_channel_id,model,
        COALESCE(requested_model,'') AS requested_model,COALESCE(upstream_model,'') AS upstream_model,
        COALESCE(billing_mode,'token') AS billing_mode,${billingColumns}
        input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
        total_cost AS standard_cost_usd_reference,actual_cost AS user_charge_cny,
        COALESCE(rate_multiplier,1) AS user_rate_multiplier,account_rate_multiplier,
        duration_ms,first_token_ms,created_at AS occurred_at
      FROM ${this.source}.usage_logs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`, [since, this.config.syncBatchSize]);
    await inTransaction(this.finopsPool, async (client) => {
      if (rows.rowCount) await this.upsertUsageRows(client, rows.rows);
    });
  }

  async syncPayments() {
    const cursor = await this.readCursor('payment_orders');
    const orderFilter = this.config.subscriptionsEnabled ? '' : " AND COALESCE(order_type,'balance')='balance'";
    const subscriptionColumns = this.config.subscriptionsEnabled
      ? ',plan_id,subscription_group_id,subscription_days'
      : '';
    const sourceRows = await this.sourcePool.query(`
      SELECT id,user_id,pay_amount,amount,COALESCE(provider_snapshot->>'currency','CNY') AS currency,
        provider_snapshot,payment_type,order_type${subscriptionColumns},status,
        refund_amount,paid_at,refund_at,fee_rate,recharge_code,updated_at
      FROM ${this.source}.payment_orders
      WHERE (updated_at,id)>($1,$2)${orderFilter} ORDER BY updated_at,id LIMIT $3`,
    [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'payment_orders');
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
    const orderType = this.config.subscriptionsEnabled ? (row.order_type || 'balance') : 'balance';
    const currency = String(row.currency || 'CNY').toUpperCase();
    const pay = decimal(row.pay_amount);
    const credited = orderType === 'balance' ? decimal(row.amount) : new Decimal(0);
    const basePaid = currency === 'CNY' ? pay : new Decimal(0);
    const cashStatus = currency === 'CNY' ? 'confirmed' : 'pending_fx';
    const paymentType = String(row.payment_type || '');
    const transactionType = orderType === 'subscription' ? 'subscription_purchase' : 'recharge';
    const metadata = JSON.stringify({
      credited_amount: credited.toString(), order_type: orderType,
      ...(this.config.subscriptionsEnabled ? {
        plan_id: row.plan_id, subscription_group_id: row.subscription_group_id, subscription_days: row.subscription_days,
      } : {}),
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
    const cursor = await this.readCursor('redeem_codes');
    const sourceRows = await this.sourcePool.query(`
      SELECT rc.id,rc.code,rc.type,rc.value,rc.status,rc.used_by,rc.used_at,rc.notes,rc.created_at,
        po.id AS payment_order_id,po.amount AS payment_amount,po.pay_amount AS payment_pay_amount,
        COALESCE(po.provider_snapshot->>'currency','CNY') AS payment_currency
      FROM ${this.source}.redeem_codes rc
      LEFT JOIN ${this.source}.payment_orders po ON po.recharge_code=rc.code AND po.order_type='balance' AND po.paid_at IS NOT NULL
      WHERE (COALESCE(rc.used_at,rc.created_at),rc.id)>($1,$2)
      ORDER BY COALESCE(rc.used_at,rc.created_at),rc.id LIMIT $3`,
    [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'redeem_codes');
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
    const cursor = await this.readCursor('user_affiliate_ledger');
    const sourceRows = await this.sourcePool.query(`
      SELECT id,user_id,action,amount,source_user_id,source_order_id,created_at,updated_at
      FROM ${this.source}.user_affiliate_ledger
      WHERE (updated_at,id)>($1,$2) ORDER BY updated_at,id LIMIT $3`,
    [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'user_affiliate_ledger');
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
    const cursor = await this.readCursor('payment_audit_logs');
    const rows = await this.sourcePool.query(`
      SELECT id,order_id,action,detail,operator,created_at
      FROM ${this.source}.payment_audit_logs WHERE (created_at,id)>($1,$2)
      ORDER BY created_at,id LIMIT $3`, [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'payment_audit_logs');
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
    const cursor = await this.readCursor('user_subscriptions');
    const rows = await this.sourcePool.query(`
      SELECT id,user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,updated_at,deleted_at
      FROM ${this.source}.user_subscriptions WHERE (updated_at,id)>($1,$2)
      ORDER BY updated_at,id LIMIT $3`, [sourceTimestamp(cursor), cursor?.cursor_id || 0, this.config.syncBatchSize]);
    return inTransaction(this.finopsPool, async (client) => {
      await this.cursor(client, 'user_subscriptions');
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
    const source = await this.sourcePool.query(`SELECT COALESCE(SUM(actual_cost),0) AS total FROM ${this.source}.usage_logs WHERE created_at >= $1 AND created_at < $2`, [start, end]);
    const finops = await this.finopsPool.query(`SELECT COALESCE(SUM(user_charge_cny),0) AS total FROM ${this.schema}.fact_usage_events WHERE occurred_at >= $1 AND occurred_at < $2`, [start, end]);
    const sourceTotal = source.rows[0].total;
    const finopsTotal = finops.rows[0].total;
    await this.finopsPool.query(`
      INSERT INTO ${this.schema}.reconciliation_runs(reconciliation_type,period_start,period_end,status,source_total,finops_total,difference,details,completed_at)
      VALUES('usage_cny',$1,$2,CASE WHEN ABS($3::numeric-$4::numeric)<0.000001 THEN 'matched' ELSE 'warning' END,$3,$4,$3::numeric-$4::numeric,$5::jsonb,NOW())`,
    [start, end, sourceTotal, finopsTotal, JSON.stringify({ unit: 'CNY', sourceField: 'actual_cost', finopsField: 'user_charge_cny' })]);
  }

  async refreshRecentPayments() {
    if (!this.config.syncLookbackSeconds) return 0;
    const since = new Date(Date.now() - this.config.syncLookbackSeconds * 1000);
    const orderFilter = this.config.subscriptionsEnabled ? '' : " AND COALESCE(order_type,'balance')='balance'";
    const subscriptionColumns = this.config.subscriptionsEnabled
      ? ',plan_id,subscription_group_id,subscription_days'
      : '';
    const sourceRows = await this.sourcePool.query(`
      SELECT id,user_id,pay_amount,amount,COALESCE(provider_snapshot->>'currency','CNY') AS currency,
        provider_snapshot,payment_type,order_type${subscriptionColumns},status,
        refund_amount,paid_at,refund_at,fee_rate,recharge_code,updated_at
      FROM ${this.source}.payment_orders
      WHERE updated_at >= $1${orderFilter}
      ORDER BY updated_at DESC,id DESC LIMIT $2`,
    [since, this.config.syncBatchSize]);
    if (!sourceRows.rowCount) return 0;
    return inTransaction(this.finopsPool, async (client) => {
      const users = new Set();
      for (const row of sourceRows.rows) {
        const affectedUsers = await this.upsertPaymentRow(client, row);
        for (const userId of affectedUsers) users.add(Number(userId));
      }
      for (const userId of users) if (userId) await this.rebuildUserLedger(client, userId);
      return sourceRows.rowCount;
    });
  }

  async reconcileWalletBalances() {
    return inTransaction(this.finopsPool, async (client) => {
      const checkedAt = new Date();
      const balances = await client.query(`
        WITH ledger_activity AS (
          SELECT source_user_id,COALESCE(SUM(amount),0) AS ledger_activity_cny
          FROM (
            SELECT source_user_id,
              CASE WHEN direction='in' THEN credit_amount ELSE -credit_amount END AS amount
            FROM ${this.schema}.credit_events
            WHERE source_user_id<>0
              AND COALESCE(metadata->>'accounting_scope','')<>'affiliate_quota'
              AND COALESCE(metadata->>'linked_recharge','false')<>'true'
            UNION ALL
            SELECT source_user_id,-user_charge_cny AS amount
            FROM ${this.schema}.fact_usage_events
            WHERE source_user_id<>0 AND billing_type=0
          ) events
          GROUP BY source_user_id
        )
        SELECT u.source_user_id,u.current_balance AS source_balance_cny,
               COALESCE(l.ledger_activity_cny,0) AS ledger_activity_cny
        FROM ${this.schema}.dim_users u
        LEFT JOIN ledger_activity l USING(source_user_id)
        WHERE u.source_deleted_at IS NULL`);

      let sourceDeltaTotal = new Decimal(0);
      let ledgerDeltaTotal = new Decimal(0);
      let differenceTotal = new Decimal(0);
      let mismatchCount = 0;
      let baselineCount = 0;
      const users = [];

      for (const row of balances.rows) {
        const sourceBalance = decimal(row.source_balance_cny);
        const ledgerActivity = decimal(row.ledger_activity_cny);
        const previousResult = await client.query(`
          SELECT source_balance_cny,ledger_activity_cny
          FROM ${this.schema}.wallet_reconciliation_snapshots
          WHERE source_user_id=$1 FOR UPDATE`, [row.source_user_id]);
        const previous = previousResult.rows[0];
        const sourceDelta = previous ? sourceBalance.minus(decimal(previous.source_balance_cny)) : new Decimal(0);
        const ledgerDelta = previous ? ledgerActivity.minus(decimal(previous.ledger_activity_cny)) : new Decimal(0);
        const difference = sourceDelta.minus(ledgerDelta);
        const status = previous ? (difference.abs().lt('0.000001') ? 'matched' : 'warning') : 'baseline';

        if (!previous) baselineCount += 1;
        if (status === 'warning') mismatchCount += 1;
        sourceDeltaTotal = sourceDeltaTotal.plus(sourceDelta);
        ledgerDeltaTotal = ledgerDeltaTotal.plus(ledgerDelta);
        differenceTotal = differenceTotal.plus(difference);
        users.push({
          sourceUserId: row.source_user_id,
          sourceDeltaCny: sourceDelta.toString(),
          ledgerDeltaCny: ledgerDelta.toString(),
          differenceCny: difference.toString(),
          status,
        });

        await client.query(`
          INSERT INTO ${this.schema}.wallet_reconciliation_snapshots(
            source_user_id,source_balance_cny,ledger_activity_cny,last_difference_cny,status,checked_at)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(source_user_id) DO UPDATE SET
            source_balance_cny=EXCLUDED.source_balance_cny,
            ledger_activity_cny=EXCLUDED.ledger_activity_cny,
            last_difference_cny=EXCLUDED.last_difference_cny,
            status=EXCLUDED.status,checked_at=EXCLUDED.checked_at`,
        [row.source_user_id, sourceBalance.toString(), ledgerActivity.toString(), difference.toString(), status, checkedAt]);
      }

      const status = baselineCount ? 'baseline' : mismatchCount ? 'warning' : 'matched';
      await client.query(`
        INSERT INTO ${this.schema}.reconciliation_runs(
          reconciliation_type,period_start,period_end,status,source_total,finops_total,difference,details,completed_at)
        VALUES('wallet_balance_cny',$6,$6,$1,$2,$3,$4,$5::jsonb,NOW())`,
      [
        status, sourceDeltaTotal.toString(), ledgerDeltaTotal.toString(), differenceTotal.toString(),
        JSON.stringify({ unit: 'CNY', baselineCount, mismatchCount, userCount: balances.rowCount, users }),
        checkedAt,
      ]);
      await this.markSuccess(client, 'credit_reconciliation', { time: checkedAt, id: 0 }, balances.rowCount);
      return { status, userCount: balances.rowCount, mismatchCount };
    });
  }
}
