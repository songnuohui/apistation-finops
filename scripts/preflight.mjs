import { loadConfig } from '../src/config.mjs';
import { assertDistinctDatabases, createFinopsPool, createSourcePool } from '../src/db.mjs';
import { SyncService } from '../src/services/sync-service.mjs';

const config = loadConfig();
if (config.demoMode) throw new Error('SOURCE_DATABASE_URL and FINOPS_DATABASE_URL are required for the read-only preflight');

const sourcePool = createSourcePool(config);
const finopsPool = createFinopsPool(config);
const sourceTableNames = [
  'users', 'accounts', 'payment_orders', 'redeem_codes',
  'user_affiliate_ledger', 'payment_audit_logs',
];
if (config.syncUsageEnabled) sourceTableNames.push('usage_logs');
if (config.subscriptionsEnabled) sourceTableNames.push('user_subscriptions');

try {
  const isolation = await assertDistinctDatabases(sourcePool, finopsPool);
  const sync = new SyncService(sourcePool, finopsPool, config);
  const unitContract = await sync.validateSourceSchema();

  const database = await sourcePool.query(`
    SELECT current_database() AS database_name,current_user AS role_name,
           current_setting('server_version') AS server_version,
           current_setting('TimeZone') AS server_timezone`);
  const relations = await sourcePool.query(`
    SELECT c.relname AS table_name,GREATEST(c.reltuples,0)::bigint AS estimated_rows,
           pg_total_relation_size(c.oid)::bigint AS total_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')
    ORDER BY c.relname`, [config.sourceSchema, sourceTableNames]);
  const ranges = await sourcePool.query(`
    SELECT
      ${config.syncUsageEnabled
    ? `(SELECT MIN(created_at) FROM "${config.sourceSchema}".usage_logs)`
    : 'NULL::timestamptz'} AS usage_first_at,
      ${config.syncUsageEnabled
    ? `(SELECT MAX(created_at) FROM "${config.sourceSchema}".usage_logs)`
    : 'NULL::timestamptz'} AS usage_last_at,
      (SELECT MIN(paid_at) FROM "${config.sourceSchema}".payment_orders WHERE paid_at IS NOT NULL) AS payment_first_at,
       (SELECT MAX(paid_at) FROM "${config.sourceSchema}".payment_orders WHERE paid_at IS NOT NULL) AS payment_last_at`);
  const rechargeRatios = await sourcePool.query(`
    SELECT COUNT(*)::bigint AS sample_count,
           MIN(amount/NULLIF(pay_amount,0)) AS min_ratio,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (amount/NULLIF(pay_amount,0))::double precision) AS median_ratio,
           MAX(amount/NULLIF(pay_amount,0)) AS max_ratio
    FROM (
      SELECT amount,pay_amount
      FROM "${config.sourceSchema}".payment_orders
      WHERE order_type='balance' AND paid_at IS NOT NULL AND amount>0 AND pay_amount>0
      ORDER BY paid_at DESC,id DESC
      LIMIT 1000
    ) recent_paid_orders`);
  const sourceAccounts = `${config.sourceSchema}.accounts`;
  const sourceSettings = `${config.sourceSchema}.settings`;
  const balanceSettingsView = `${config.sourceSettingsSchema}.balance_recharge_multiplier`;
  const privileges = await sourcePool.query(`
    SELECT
      has_column_privilege(current_user,$1,'credentials','SELECT') AS can_read_account_credentials,
      has_column_privilege(current_user,$1,'extra','SELECT') AS can_read_account_extra,
      has_table_privilege(current_user,$1,'INSERT') OR
      has_table_privilege(current_user,$1,'UPDATE') OR
      has_table_privilege(current_user,$1,'DELETE') AS can_write_source_accounts,
      has_column_privilege(current_user,$2,'key','SELECT') OR
      has_column_privilege(current_user,$2,'value','SELECT') AS can_read_source_settings,
      has_table_privilege(current_user,$3,'SELECT') AS can_read_balance_settings_view`,
  [sourceAccounts, sourceSettings, balanceSettingsView]);

  const security = privileges.rows[0];
  if (security.can_read_account_credentials) {
    throw new Error('unsafe database role: accounts.credentials is readable');
  }
  if (!security.can_read_account_extra) {
    throw new Error('database role cannot read accounts.extra required for sanitized upstream billing probe snapshots');
  }
  if (security.can_write_source_accounts) {
    throw new Error('unsafe database role: source tables are writable');
  }
  if (security.can_read_source_settings) {
    throw new Error('unsafe database role: public.settings is readable; only the restricted balance multiplier view may be granted');
  }
  if (!security.can_read_balance_settings_view) {
    throw new Error('database role cannot read the restricted balance multiplier view');
  }
  const sourceWrite = await sourcePool.query(`
    SELECT
      has_schema_privilege(current_user,$1,'CREATE') AS can_create_in_source_schema,
      EXISTS(
        SELECT 1
        FROM unnest($2::text[]) AS source_table
        WHERE has_table_privilege(current_user,format('%I.%I',$1,source_table),'INSERT')
          OR has_table_privilege(current_user,format('%I.%I',$1,source_table),'UPDATE')
          OR has_table_privilege(current_user,format('%I.%I',$1,source_table),'DELETE')
      ) AS can_write_source_tables`,
  [config.sourceSchema, sourceTableNames]);
  if (sourceWrite.rows[0].can_create_in_source_schema || sourceWrite.rows[0].can_write_source_tables) {
    throw new Error('unsafe database role: source schema or source tables are writable');
  }
  const ratio = rechargeRatios.rows[0];
  const medianRatio = ratio.median_ratio === null ? null : Number(ratio.median_ratio);
  if (medianRatio !== null && (!Number.isFinite(medianRatio) || medianRatio <= 0 || medianRatio > 1000)) {
    throw new Error(`abnormal payment amount/pay_amount ratio: ${ratio.median_ratio}`);
  }
  const warnings = [];
  if (!unitContract.settingPresent) warnings.push('BALANCE_RECHARGE_MULTIPLIER is missing; FinOps assumes 1');
  if (unitContract.balanceRechargeMultiplier !== 1) {
    warnings.push('BALANCE_RECHARGE_MULTIPLIER is not 1; FinOps treats it as a CNY bonus/discount multiplier, not USD conversion');
  }
  if (medianRatio !== null) {
    const expected = Number(unitContract.balanceRechargeMultiplier);
    const tolerance = Math.max(0.01, Math.abs(expected) * 0.05);
    if (Math.abs(medianRatio - expected) > tolerance) {
      warnings.push('recent payment_orders amount/pay_amount median differs from BALANCE_RECHARGE_MULTIPLIER');
    }
  }

  console.log(JSON.stringify({
    status: 'compatible',
    sourceSchema: config.sourceSchema,
    database: database.rows[0],
    isolation,
    security: {
      sourceTablesReadOnly: true,
      accountCredentialsReadable: false,
      accountProbeExtraReadable: true,
      sourceSettingsReadable: false,
      balanceSettingsView,
    },
    unitContract: {
      sourceBalanceUnit: unitContract.sourceBalanceUnit,
      balanceRechargeMultiplier: unitContract.balanceRechargeMultiplier,
      settingPresent: unitContract.settingPresent,
      recentPaidOrderRatios: ratio,
      warnings,
    },
    timeRanges: ranges.rows[0],
    tables: relations.rows,
  }, null, 2));
} finally {
  await Promise.all([sourcePool.end(), finopsPool.end()]);
}
