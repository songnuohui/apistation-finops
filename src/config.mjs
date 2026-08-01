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

function httpUrl(value, name) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${name} is required when authentication is enabled`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL for ${name}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`invalid URL for ${name}`);
  }
  return parsed.origin;
}

function embedOrigins(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let parsed;
    try {
      parsed = new URL(item);
    } catch {
      throw new Error(`invalid monitor embed origin: ${item}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`invalid monitor embed origin: ${item}`);
    }
    return parsed.origin;
  }))];
}

export function loadConfig(env = process.env) {
  const sourceDatabaseUrl = env.SOURCE_DATABASE_URL?.trim() || '';
  const finopsDatabaseUrl = env.FINOPS_DATABASE_URL?.trim() || '';
  const nodeEnv = env.NODE_ENV || 'development';
  if (env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is no longer supported; configure separate SOURCE_DATABASE_URL and FINOPS_DATABASE_URL');
  }
  if (Boolean(sourceDatabaseUrl) !== Boolean(finopsDatabaseUrl)) {
    throw new Error('SOURCE_DATABASE_URL and FINOPS_DATABASE_URL must be configured together');
  }
  if (nodeEnv === 'production' && (!sourceDatabaseUrl || !finopsDatabaseUrl)) {
    throw new Error('SOURCE_DATABASE_URL and FINOPS_DATABASE_URL are required in production; demo mode is disabled');
  }
  const authDisabled = boolValue(env.AUTH_DISABLED, nodeEnv !== 'production');
  const sessionSecret = env.SESSION_SECRET?.trim() || '';
  const sessionCookieSecure = boolValue(env.SESSION_COOKIE_SECURE, nodeEnv === 'production');
  if (!authDisabled && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 random characters when authentication is enabled');
  }
  if (nodeEnv === 'production' && !authDisabled && !sessionCookieSecure) {
    throw new Error('SESSION_COOKIE_SECURE must be true in production');
  }
  if (env.UPSTREAM_USD_TO_CNY_RATE?.trim()) {
    throw new Error('UPSTREAM_USD_TO_CNY_RATE is no longer supported; all FinOps accounting entries must be recorded in CNY');
  }

  return Object.freeze({
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: intValue(env.PORT, 8090, { min: 1, max: 65535 }),
    sourceDatabaseUrl,
    finopsDatabaseUrl,
    demoMode: sourceDatabaseUrl === '' && finopsDatabaseUrl === '',
    finopsSchema: schemaName(env.FINOPS_SCHEMA, 'finops'),
    sourceSchema: schemaName(env.SOURCE_SCHEMA, 'public'),
    sourceSettingsSchema: schemaName(env.SOURCE_SETTINGS_SCHEMA, 'finops_source'),
    syncEnabled: sourceDatabaseUrl !== '' && boolValue(env.SYNC_ENABLED, true),
    syncIntervalSeconds: intValue(env.SYNC_INTERVAL_SECONDS, 60, { min: 10, max: 3600 }),
    syncBatchSize: intValue(env.SYNC_BATCH_SIZE, 1000, { min: 100, max: 10000 }),
    syncMaxBatchesPerCycle: intValue(env.SYNC_MAX_BATCHES_PER_CYCLE, 3, { min: 1, max: 20 }),
    syncLookbackSeconds: intValue(env.SYNC_LOOKBACK_SECONDS, 600, { min: 0, max: 86400 }),
    subscriptionsEnabled: boolValue(env.SUBSCRIPTIONS_ENABLED, false),
    detailRetentionDays: intValue(env.DETAIL_RETENTION_DAYS, 180, { min: 30, max: 3650 }),
    baseCurrency: cnyCurrency(env.BASE_CURRENCY, 'BASE_CURRENCY'),
    billingUnit: cnyCurrency(env.BILLING_UNIT, 'BILLING_UNIT'),
    sourceBalanceUnit: cnyCurrency(env.SOURCE_BALANCE_UNIT, 'SOURCE_BALANCE_UNIT'),
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    authDisabled,
    sub2apiAuthUrl: authDisabled ? null : httpUrl(env.SUB2API_AUTH_URL, 'SUB2API_AUTH_URL'),
    sub2apiAuthTimeoutMs: intValue(env.SUB2API_AUTH_TIMEOUT_MS, 10_000, { min: 1_000, max: 30_000 }),
    sessionSecret,
    sessionTtlSeconds: intValue(env.SESSION_TTL_SECONDS, 43_200, { min: 900, max: 86_400 }),
    sessionCookieSecure,
    monitorEmbedOrigins: embedOrigins(env.MONITOR_EMBED_ORIGINS),
  });
}
