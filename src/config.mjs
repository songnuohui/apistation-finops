const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

function intValue(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return parsed;
}

function boolValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function schemaName(value, fallback) {
  const selected = value || fallback;
  if (!IDENTIFIER.test(selected)) throw new Error(`invalid PostgreSQL schema: ${selected}`);
  return selected;
}

function cnyCurrency(value, name) {
  const currency = String(value || 'CNY').trim().toUpperCase();
  if (currency !== 'CNY') {
    throw new Error(`${name} must be CNY; USD values are display-only Token price references`);
  }
  return 'CNY';
}

export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  const nodeEnv = env.NODE_ENV || 'development';
  if (nodeEnv === 'production' && databaseUrl === '') {
    throw new Error('DATABASE_URL is required in production; demo mode is disabled');
  }
  const authDisabled = boolValue(env.AUTH_DISABLED, nodeEnv !== 'production');
  const adminToken = env.ADMIN_TOKEN?.trim() || '';
  if (!authDisabled && adminToken.length < 24) {
    throw new Error('ADMIN_TOKEN must contain at least 24 characters when authentication is enabled');
  }
  if (env.UPSTREAM_USD_TO_CNY_RATE?.trim()) {
    throw new Error('UPSTREAM_USD_TO_CNY_RATE is no longer supported; all FinOps accounting entries must be recorded in CNY');
  }

  return Object.freeze({
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: intValue(env.PORT, 8090, { min: 1, max: 65535 }),
    databaseUrl,
    demoMode: databaseUrl === '',
    finopsSchema: schemaName(env.FINOPS_SCHEMA, 'finops'),
    sourceSchema: schemaName(env.SOURCE_SCHEMA, 'public'),
    sourceSettingsSchema: schemaName(env.SOURCE_SETTINGS_SCHEMA, 'finops_source'),
    syncEnabled: databaseUrl !== '' && boolValue(env.SYNC_ENABLED, true),
    syncIntervalSeconds: intValue(env.SYNC_INTERVAL_SECONDS, 60, { min: 10, max: 3600 }),
    syncBatchSize: intValue(env.SYNC_BATCH_SIZE, 1000, { min: 100, max: 10000 }),
    syncMaxBatchesPerCycle: intValue(env.SYNC_MAX_BATCHES_PER_CYCLE, 3, { min: 1, max: 20 }),
    syncLookbackSeconds: intValue(env.SYNC_LOOKBACK_SECONDS, 600, { min: 0, max: 86400 }),
    detailRetentionDays: intValue(env.DETAIL_RETENTION_DAYS, 180, { min: 30, max: 3650 }),
    baseCurrency: cnyCurrency(env.BASE_CURRENCY, 'BASE_CURRENCY'),
    billingUnit: cnyCurrency(env.BILLING_UNIT, 'BILLING_UNIT'),
    sourceBalanceUnit: cnyCurrency(env.SOURCE_BALANCE_UNIT, 'SOURCE_BALANCE_UNIT'),
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    authDisabled,
    adminToken,
  });
}
