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

function enumValue(value, fallback, allowed, name) {
  const selected = String(value || fallback).trim().toLowerCase();
  if (!allowed.includes(selected)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return selected;
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

function optionalHttpUrl(value, name) {
  const raw = String(value || '').trim();
  return raw ? httpUrl(raw, name) : '';
}

function redisUrl(value, name) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL for ${name}`);
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error(`invalid URL for ${name}`);
  }
  const database = parsed.pathname.replace(/^\/+/, '');
  if (!/^\d+$/.test(database) || Number(database) === 0) {
    throw new Error(`${name} must select a non-default isolated Redis database`);
  }
  return parsed.toString();
}

function sourceRedisUrl(value, name) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL for ${name}`);
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error(`invalid URL for ${name}`);
  }
  const database = parsed.pathname.replace(/^\/+/, '');
  if (database && !/^\d+$/.test(database)) {
    throw new Error(`${name} must use a numeric Redis database`);
  }
  return parsed.toString();
}

function redisKeyPrefix(value) {
  const prefix = String(value || 'finops:cache:').trim();
  if (!/^[a-zA-Z0-9:_-]{3,80}$/.test(prefix) || !prefix.endsWith(':')) {
    throw new Error('FINOPS_REDIS_KEY_PREFIX must be a simple prefix ending with ":"');
  }
  return prefix;
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

function hostList(value, name) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let parsed;
    try {
      parsed = new URL(item.includes('://') ? item : `https://${item}`);
    } catch {
      throw new Error(`invalid hostname in ${name}: ${item}`);
    }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port) {
      throw new Error(`invalid hostname in ${name}: ${item}`);
    }
    return parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  }))];
}

export function loadConfig(env = process.env) {
  const sourceDatabaseUrl = env.SOURCE_DATABASE_URL?.trim() || '';
  const finopsDatabaseUrl = env.FINOPS_DATABASE_URL?.trim() || '';
  const sub2apiUsageDatabaseUrl = env.SUB2API_USAGE_DATABASE_URL?.trim() || sourceDatabaseUrl;
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
  const supplierCredentialsKey = env.SUPPLIER_CREDENTIALS_KEY?.trim() || '';
  const emailCredentialsKey = env.FINOPS_EMAIL_CREDENTIALS_KEY?.trim() || supplierCredentialsKey;
  const syncUsageEnabled = sourceDatabaseUrl !== '' && boolValue(env.SYNC_USAGE_ENABLED, false);
  if (syncUsageEnabled) {
    throw new Error('SYNC_USAGE_ENABLED=true is no longer supported; usage must be queried from the read-only Sub2API administrator API');
  }
  const configuredSupplierBlockedHosts = hostList(env.SUPPLIER_BLOCKED_HOSTS, 'SUPPLIER_BLOCKED_HOSTS');
  if (nodeEnv === 'production' && supplierCredentialsKey && !configuredSupplierBlockedHosts.length) {
    throw new Error('SUPPLIER_BLOCKED_HOSTS is required in production when supplier monitoring is enabled');
  }
  const supplierBlockedHosts = [...new Set([
    ...configuredSupplierBlockedHosts,
    ...(authDisabled ? [] : [new URL(httpUrl(env.SUB2API_AUTH_URL, 'SUB2API_AUTH_URL')).hostname.toLowerCase()]),
  ])];

  return Object.freeze({
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: intValue(env.PORT, 8090, { min: 1, max: 65535 }),
    sourceDatabaseUrl,
    finopsDatabaseUrl,
    sub2apiUsageDatabaseUrl,
    sourceDatabasePoolMax: intValue(env.SOURCE_DATABASE_POOL_MAX, 3, { min: 1, max: 10 }),
    sub2apiUsageDatabasePoolMax: intValue(env.SUB2API_USAGE_DATABASE_POOL_MAX, 2, { min: 1, max: 4 }),
    finopsDatabasePoolMax: intValue(env.FINOPS_DATABASE_POOL_MAX, 8, { min: 2, max: 20 }),
    sourceStatementTimeoutMs: intValue(env.SOURCE_STATEMENT_TIMEOUT_MS, 10_000, { min: 1_000, max: 30_000 }),
    finopsStatementTimeoutMs: intValue(env.FINOPS_STATEMENT_TIMEOUT_MS, 30_000, { min: 5_000, max: 120_000 }),
    demoMode: sourceDatabaseUrl === '' && finopsDatabaseUrl === '',
    finopsSchema: schemaName(env.FINOPS_SCHEMA, 'finops'),
    sourceSchema: schemaName(env.SOURCE_SCHEMA, 'public'),
    sourceSettingsSchema: schemaName(env.SOURCE_SETTINGS_SCHEMA, 'finops_source'),
    syncEnabled: sourceDatabaseUrl !== '' && boolValue(env.SYNC_ENABLED, true),
    syncUsageEnabled: false,
    usageDataMode: enumValue(env.USAGE_DATA_MODE, 'source_api', ['source_api'], 'USAGE_DATA_MODE'),
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
    sub2apiUsageTimeoutMs: intValue(env.SUB2API_USAGE_TIMEOUT_MS, 15_000, { min: 1_000, max: 60_000 }),
    sub2apiUsageCacheTtlSeconds: intValue(env.SUB2API_USAGE_CACHE_TTL_SECONDS, 30, { min: 1, max: 300 }),
    sub2apiUsageStaleTtlSeconds: intValue(env.SUB2API_USAGE_STALE_TTL_SECONDS, 300, { min: 0, max: 3_600 }),
    sub2apiUsageMaxConcurrency: intValue(env.SUB2API_USAGE_MAX_CONCURRENCY, 2, { min: 1, max: 6 }),
    sub2apiUsageAccountFanoutLimit: intValue(env.SUB2API_USAGE_ACCOUNT_FANOUT_LIMIT, 20, { min: 10, max: 100 }),
    sub2apiServiceAuthRefreshSeconds: intValue(env.SUB2API_SERVICE_AUTH_REFRESH_SECONDS, 300, { min: 30, max: 3600 }),
    sub2apiRuntimePageSize: intValue(env.SUB2API_RUNTIME_PAGE_SIZE, 100, { min: 10, max: 100 }),
    finopsRedisUrl: redisUrl(env.FINOPS_REDIS_URL, 'FINOPS_REDIS_URL'),
    finopsRedisKeyPrefix: redisKeyPrefix(env.FINOPS_REDIS_KEY_PREFIX),
    finopsRedisConnectTimeoutMs: intValue(env.FINOPS_REDIS_CONNECT_TIMEOUT_MS, 1_500, { min: 250, max: 10_000 }),
    dashboardCacheTtlSeconds: intValue(env.DASHBOARD_CACHE_TTL_SECONDS, 5, { min: 1, max: 60 }),
    listCacheTtlSeconds: intValue(env.LIST_CACHE_TTL_SECONDS, 3, { min: 1, max: 60 }),
    runtimeCacheTtlSeconds: intValue(env.RUNTIME_CACHE_TTL_SECONDS, 10, { min: 1, max: 30 }),
    sub2apiRedisUrl: sourceRedisUrl(env.SUB2API_REDIS_URL, 'SUB2API_REDIS_URL'),
    sub2apiRedisConnectTimeoutMs: intValue(env.SUB2API_REDIS_CONNECT_TIMEOUT_MS, 1_500, { min: 250, max: 10_000 }),
    sub2apiRedisRuntimeUserLimit: intValue(env.SUB2API_REDIS_RUNTIME_USER_LIMIT, 500, { min: 1, max: 5_000 }),
    sub2apiRedisRuntimeAccountLimit: intValue(env.SUB2API_REDIS_RUNTIME_ACCOUNT_LIMIT, 500, { min: 1, max: 5_000 }),
    runtimeSnapshotIntervalSeconds: intValue(env.RUNTIME_SNAPSHOT_INTERVAL_SECONDS, 10, { min: 5, max: 300 }),
    runtimeLiveRefreshSeconds: intValue(env.RUNTIME_LIVE_REFRESH_SECONDS, 2, { min: 1, max: 30 }),
    supplierCredentialsKey,
    emailCredentialsKey,
    finopsPublicUrl: optionalHttpUrl(env.FINOPS_PUBLIC_URL, 'FINOPS_PUBLIC_URL') || (nodeEnv === 'production' ? '' : `http://${env.HOST || '127.0.0.1'}:${env.PORT || 8090}`),
    supplierBlockedHosts: Object.freeze(supplierBlockedHosts),
    supplierMonitorIntervalSeconds: intValue(env.SUPPLIER_MONITOR_INTERVAL_SECONDS, 3, { min: 3, max: 3600 }),
    supplierRequestTimeoutMs: intValue(env.SUPPLIER_REQUEST_TIMEOUT_MS, 30_000, { min: 2_000, max: 30_000 }),
    supplierMaxResponseBytes: intValue(env.SUPPLIER_MAX_RESPONSE_BYTES, 1_048_576, { min: 65_536, max: 5_242_880 }),
    sessionSecret,
    sessionTtlSeconds: intValue(env.SESSION_TTL_SECONDS, 43_200, { min: 900, max: 86_400 }),
    sessionCookieSecure,
    monitorEmbedOrigins: embedOrigins(env.MONITOR_EMBED_ORIGINS),
  });
}
