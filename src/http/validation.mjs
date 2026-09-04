import Decimal from 'decimal.js/decimal.mjs';

const COST_TYPES = new Set(['metered', 'prepaid', 'subscription', 'one_time', 'free', 'hybrid']);
const ALLOCATION_METHODS = new Set(['standard_cost_weight', 'token_weight', 'none']);
const COST_MODES = new Set(['probe_multiplier', 'manual_multiplier', 'fixed_purchase', 'free']);
const BASIS_MODES = new Set(['revenue_backsolve', 'reference_cny']);
const COST_CHANGE_STRATEGIES = new Set(['future_only', 'current_day', 'custom_time']);
const FIXED_ALLOCATION_STRATEGIES = new Set(['equal', 'standard_cost_weight', 'token_weight']);
const CASH_TYPES = new Set([
  'other_expense', 'other_income', 'gateway_fee', 'account_purchase', 'supplier_topup',
  'subscription_renewal', 'affiliate_rebate', 'manual_adjustment', 'refund',
]);
const DIRECTIONS = new Set(['in', 'out']);
const SUPPLIER_ADAPTER_TYPES = new Set(['auto', 'sub2api', 'newapi', 'openai_compatible', 'custom']);
const SUPPLIER_AUTH_MODES = new Set(['password', 'access_token', 'token_refresh', 'api_key']);
const SUPPLIER_QUALITY_MODES = new Set(['off', 'passive', 'active', 'hybrid']);
const MONITOR_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'grok']);
const MONITOR_API_MODES = new Set(['chat_completions', 'responses']);
const MONITOR_BODY_MODES = new Set(['off', 'merge', 'replace']);
const MONITOR_FORBIDDEN_HEADERS = new Set([
  'connection', 'content-length', 'content-encoding', 'host',
  'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
const MONITOR_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const PROFIT_GUARD_THRESHOLD_MODES = new Set(['margin', 'minimum_sale_multiplier']);
const SUB2API_SERVICE_AUTH_MODES = new Set(['password', 'api_key']);
const EMAIL_CATEGORIES = new Set(['announcement', 'promotion']);
const EMAIL_RECIPIENT_MODES = new Set(['all', 'selected']);
const EMAIL_PREFERENCE_COPY_DEFAULTS = {
  footerText: '这是 FinOps 公告/活动邮件。',
  unsubscribeLabel: '退订 FinOps 邮件',
  subscribeLabel: '重新订阅 FinOps 邮件',
  unsubscribedTitle: '已退订 FinOps 邮件',
  unsubscribedDescription: '之后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  subscribedTitle: '已重新订阅 FinOps 邮件',
  subscribedDescription: '之后将继续接收 FinOps 的公告和活动邮件。',
  confirmUnsubscribeTitle: '确认退订 FinOps 邮件',
  confirmUnsubscribeDescription: '确认后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  confirmUnsubscribeButton: '确认退订',
  confirmSubscribeTitle: '确认重新订阅 FinOps 邮件',
  confirmSubscribeDescription: '确认后将继续接收 FinOps 的公告和活动邮件。',
  confirmSubscribeButton: '确认重新订阅',
};

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function textValue(value, field, { required = true, max = 255 } = {}) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw badRequest(`missing field: ${field}`);
  if (normalized.length > max) throw badRequest(`${field} is too long`);
  return normalized;
}

function enumValue(value, field, allowed) {
  const normalized = textValue(value, field);
  if (!allowed.has(normalized)) throw badRequest(`invalid ${field}`);
  return normalized;
}

function decimalValue(value, field, { min = 0, allowZero = true } = {}) {
  let parsed;
  try { parsed = new Decimal(value); }
  catch { throw badRequest(`invalid ${field}`); }
  if (!parsed.isFinite() || parsed.lt(min) || (!allowZero && parsed.eq(0))) throw badRequest(`invalid ${field}`);
  return parsed.toString();
}

function currencyValue(value, field = 'currency') {
  const normalized = textValue(value, field, { max: 12 }).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,11}$/.test(normalized)) throw badRequest(`invalid ${field}`);
  return normalized;
}

function cnyCurrency(value, field) {
  const normalized = currencyValue(value === undefined || value === null || value === '' ? 'CNY' : value, field);
  if (normalized !== 'CNY') throw badRequest(`${field} must be CNY`);
  return 'CNY';
}

function cnyAmounts(input) {
  const originalAmount = decimalValue(input.originalAmount, 'originalAmount', { allowZero: false });
  const originalCurrency = cnyCurrency(input.originalCurrency, 'originalCurrency');
  if (input.fxRate !== undefined && input.fxRate !== null && input.fxRate !== '') {
    const suppliedFxRate = decimalValue(input.fxRate, 'fxRate', { allowZero: false });
    if (!new Decimal(suppliedFxRate).eq(1)) throw badRequest('fxRate must be 1 for CNY accounting');
  }
  if (input.baseAmount !== undefined && input.baseAmount !== null && input.baseAmount !== '') {
    const suppliedBaseAmount = decimalValue(input.baseAmount, 'baseAmount', { allowZero: false });
    if (!new Decimal(suppliedBaseAmount).eq(originalAmount)) {
      throw badRequest('baseAmount must equal originalAmount for CNY accounting');
    }
  }
  return { originalAmount, originalCurrency, fxRate: '1', baseAmount: originalAmount };
}

function dateValue(value, field) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw badRequest(`invalid ${field}`);
  return parsed.toISOString();
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest(`invalid ${field}`);
  return parsed;
}

function optionalDecimal(value, field, { min = 0, allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  return decimalValue(value, field, { min, allowZero });
}

function optionalEnum(value, field, allowed) {
  if (value === undefined || value === null || value === '') return null;
  return enumValue(value, field, allowed);
}

function integerValue(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw badRequest(`invalid ${field}`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw badRequest(`invalid ${field}`);
  return parsed;
}

function booleanValue(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw badRequest(`invalid ${field}`);
}

function monitorEndpoint(value) {
  const normalized = textValue(value, 'endpoint', { max: 500 });
  let parsed;
  try { parsed = new URL(normalized); } catch { throw badRequest('invalid endpoint'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw badRequest('endpoint must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return parsed.origin;
}

function monitorModels(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  const models = [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
  if (models.length > 20 || models.some((model) => model.length > 200)) throw badRequest('invalid extraModels');
  return models;
}

function monitorHeaders(value) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid extraHeaders');
  const entries = Object.entries(value)
    .map(([key, item]) => [String(key).trim(), String(item ?? '').trim()])
    .filter(([key, item]) => key && item);
  if (entries.some(([key]) => !MONITOR_HEADER_NAME.test(key)
    || MONITOR_FORBIDDEN_HEADERS.has(key.toLowerCase()))) {
    throw badRequest('invalid or forbidden extraHeaders');
  }
  if (entries.length > 40 || entries.some(([key, item]) => key.length > 100 || item.length > 2000)) {
    throw badRequest('invalid extraHeaders');
  }
  return Object.fromEntries(entries);
}

function monitorBody(value) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid bodyOverride');
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32_768) throw badRequest('bodyOverride is too large');
  } catch (error) {
    if (error?.statusCode) throw error;
    throw badRequest('invalid bodyOverride');
  }
  return value;
}

function validateMonitorReplaceBody(provider, apiMode, body) {
  if (!Object.keys(body).length) throw badRequest('replace bodyOverride cannot be empty');
  if (provider === 'openai' && apiMode === 'responses'
    && (!String(body.instructions || '').trim()
      || body.input === undefined || body.input === null || String(body.input).trim() === '')) {
    throw badRequest('responses replace bodyOverride requires instructions and input');
  }
  if ((provider === 'openai' || provider === 'grok') && apiMode === 'chat_completions'
    && (!Array.isArray(body.messages) || !body.messages.length)) {
    throw badRequest('chat completions replace bodyOverride requires messages');
  }
}

function idList(value, field, { max = 100 } = {}) {
  const source = Array.isArray(value) ? value : [];
  const ids = [...new Set(source.map((item) => optionalId(item, field)).filter(Boolean))];
  if (!ids.length || ids.length > max) throw badRequest(`invalid ${field}`);
  return ids;
}

function tagValues(value) {
  if (value === undefined || value === null || value === '') return null;
  const source = Array.isArray(value) ? value : String(value).split(',');
  const tags = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) throw badRequest('invalid tags');
  return tags;
}

export function normalizeCostProfile(input) {
  const costType = enumValue(input.costType, 'costType', COST_TYPES);
  const costMode = optionalEnum(input.costMode, 'costMode', COST_MODES) || (costType === 'free' ? 'free' : 'fixed_purchase');
  const basisMode = optionalEnum(input.basisMode, 'basisMode', BASIS_MODES) || 'revenue_backsolve';
  const cnyPerReferenceUnit = optionalDecimal(input.cnyPerReferenceUnit, 'cnyPerReferenceUnit', { min: 0, allowZero: false });
  const variableMultiplier = optionalDecimal(input.variableMultiplier, 'variableMultiplier', { min: 0, allowZero: false });
  if (costType === 'free' && costMode !== 'free') {
    throw badRequest('free costType requires free costMode');
  }
  if (costMode === 'free' && costType !== 'free') {
    throw badRequest('free costMode requires free costType');
  }
  if (costMode === 'manual_multiplier' && !variableMultiplier) {
    throw badRequest('manual_multiplier requires variableMultiplier');
  }
  if (basisMode === 'reference_cny' && !cnyPerReferenceUnit) {
    throw badRequest('reference_cny requires cnyPerReferenceUnit');
  }
  return {
    name: textValue(input.name, 'name', { max: 120 }),
    costType,
    costMode,
    basisMode,
    cnyPerReferenceUnit,
    variableMultiplier,
    currency: cnyCurrency(input.currency, 'currency'),
    allocationMethod: enumValue(input.allocationMethod, 'allocationMethod', ALLOCATION_METHODS),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

function normalizeAccountCostPeriodFields(input, accountId, { updating = false } = {}) {
  const effectiveFrom = dateValue(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = dateValue(input.effectiveTo, 'effectiveTo');
  if (new Date(effectiveTo) <= new Date(effectiveFrom)) throw badRequest('effectiveTo must be after effectiveFrom');
  return {
    ...cnyAmounts(input),
    ...(accountId === null ? {} : { accountId }),
    costProfileId: optionalId(input.costProfileId, 'costProfileId'),
    feeAmount: decimalValue(input.feeAmount ?? 0, 'feeAmount'),
    taxAmount: decimalValue(input.taxAmount ?? 0, 'taxAmount'),
    effectiveFrom,
    effectiveTo,
    supplier: textValue(input.supplier, 'supplier', { required: false, max: 160 }),
    purchaseBatch: textValue(input.purchaseBatch, 'purchaseBatch', { required: false, max: 120 }),
    tags: tagValues(input.tags),
    allocationStrategy: optionalEnum(input.allocationStrategy, 'allocationStrategy', FIXED_ALLOCATION_STRATEGIES) || 'equal',
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
    correctionReason: updating
      ? textValue(input.correctionReason, 'correctionReason', { required: false, max: 1000 })
      : '',
  };
}

export function normalizeAccountCostPeriod(input) {
  const accountId = optionalId(input.accountId, 'accountId') ?? (() => { throw badRequest('missing field: accountId'); })();
  return normalizeAccountCostPeriodFields(input, accountId);
}

export function normalizeAccountCostPeriodUpdate(input) {
  return normalizeAccountCostPeriodFields(input, null, { updating: true });
}

function emailValue(value, field, { required = true } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized && !required) return '';
  if (!normalized || normalized.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw badRequest(`invalid ${field}`);
  }
  return normalized;
}

export function normalizeAccountCostPeriodDelete(input = {}) {
  return {
    correctionReason: textValue(
      input.correctionReason || input.reason || '误登记或重复成本记录',
      'correctionReason',
      { max: 1000 },
    ),
  };
}

export function normalizeBulkAccountCostPeriods(input) {
  const source = Array.isArray(input.accountIds) ? input.accountIds : [];
  const accountIds = [...new Set(source.map((value) => optionalId(value, 'accountIds')).filter(Boolean))];
  if (!accountIds.length || accountIds.length > 100) throw badRequest('invalid accountIds');
  return { ...normalizeAccountCostPeriodFields(input, null), accountIds };
}

export function normalizeAccountLedger(input) {
  const costMode = optionalEnum(input.costMode, 'costMode', COST_MODES);
  const basisMode = optionalEnum(input.basisMode, 'basisMode', BASIS_MODES);
  const upstreamMultiplier = optionalDecimal(input.upstreamMultiplier, 'upstreamMultiplier', { min: 0, allowZero: false });
  const cnyPerReferenceUnit = optionalDecimal(input.cnyPerReferenceUnit, 'cnyPerReferenceUnit', { min: 0, allowZero: false });
  const changeStrategy = optionalEnum(input.changeStrategy, 'changeStrategy', COST_CHANGE_STRATEGIES) || 'future_only';
  return {
    costProfileId: optionalId(input.costProfileId, 'costProfileId'),
    supplierKeyId: optionalId(input.supplierKeyId, 'supplierKeyId'),
    costMode,
    basisMode,
    upstreamMultiplier,
    cnyPerReferenceUnit,
    changeStrategy,
    effectiveFrom: changeStrategy === 'custom_time' ? dateValue(input.effectiveFrom, 'effectiveFrom') : null,
    supplier: textValue(input.supplier, 'supplier', { required: false, max: 160 }),
    purchaseBatch: textValue(input.purchaseBatch, 'purchaseBatch', { required: false, max: 120 }),
    tags: tagValues(input.tags) || [],
  };
}

export function normalizeUserBalanceStatsWhitelist(input) {
  return {
    excludeFromBalanceStats: booleanValue(input.excludeFromBalanceStats, 'excludeFromBalanceStats'),
  };
}

export function normalizeBulkUserBalanceStatsWhitelist(input) {
  return {
    userIds: idList(input.userIds, 'userIds'),
    excludeFromBalanceStats: booleanValue(input.excludeFromBalanceStats, 'excludeFromBalanceStats'),
  };
}

export function normalizeSupplierConnection(input) {
  const adapterType = enumValue(input.adapterType || 'auto', 'adapterType', SUPPLIER_ADAPTER_TYPES);
  const authMode = enumValue(input.authMode || (adapterType === 'openai_compatible' ? 'api_key' : 'password'), 'authMode', SUPPLIER_AUTH_MODES);
  const credentials = input.credentials && typeof input.credentials === 'object' && !Array.isArray(input.credentials)
    ? input.credentials : {};
  return {
    supplierName: textValue(input.supplierName, 'supplierName', { max: 160 }),
    supplierNotes: textValue(input.supplierNotes ?? input.notes, 'supplierNotes', { required: false, max: 2000 }),
    name: textValue(input.name, 'name', { max: 160 }),
    adapterType,
    baseUrl: textValue(input.baseUrl, 'baseUrl', { max: 1000 }),
    authMode,
    credentialLabel: textValue(input.credentialLabel, 'credentialLabel', { required: false, max: 255 }),
    enabled: input.enabled === undefined ? true : booleanValue(input.enabled, 'enabled'),
    alertEnabled: input.alertEnabled === undefined ? true : booleanValue(input.alertEnabled, 'alertEnabled'),
    // Seconds are intentionally bounded to keep a bad configuration from
    // creating a tight polling loop. Keep accepting the old minutes field so
    // existing clients can be upgraded without losing their setting.
    inventoryIntervalSeconds: input.inventoryIntervalSeconds !== undefined
      ? integerValue(input.inventoryIntervalSeconds, 'inventoryIntervalSeconds', { min: 3, max: 86400 })
      : input.inventoryIntervalMinutes !== undefined
        ? integerValue(input.inventoryIntervalMinutes, 'inventoryIntervalMinutes', { min: 1, max: 1440 }) * 60
        : 600,
    activeCheckEnabled: input.activeCheckEnabled === undefined ? true : booleanValue(input.activeCheckEnabled, 'activeCheckEnabled'),
    activeCheckLimit: input.activeCheckLimit === undefined
      ? 20 : integerValue(input.activeCheckLimit, 'activeCheckLimit', { min: 1, max: 100 }),
    qualityMonitorMode: enumValue(input.qualityMonitorMode || 'passive', 'qualityMonitorMode', SUPPLIER_QUALITY_MODES),
    lowBalanceThreshold: optionalDecimal(input.lowBalanceThreshold, 'lowBalanceThreshold', { min: 0, allowZero: true }),
    balanceCurrency: currencyValue(input.balanceCurrency || 'USD', 'balanceCurrency'),
    credentials: {
      username: textValue(credentials.username, 'credentials.username', { required: false, max: 255 }),
      password: textValue(credentials.password, 'credentials.password', { required: false, max: 8192 }),
      accessToken: textValue(credentials.accessToken, 'credentials.accessToken', { required: false, max: 16384 }),
      refreshToken: textValue(credentials.refreshToken, 'credentials.refreshToken', { required: false, max: 16384 }),
      apiKey: textValue(credentials.apiKey, 'credentials.apiKey', { required: false, max: 16384 }),
      totpSecret: textValue(credentials.totpSecret, 'credentials.totpSecret', { required: false, max: 256 }),
      keyName: textValue(credentials.keyName, 'credentials.keyName', { required: false, max: 200 }),
      rateMultiplier: optionalDecimal(credentials.rateMultiplier, 'credentials.rateMultiplier', { min: 0, allowZero: false }),
      balance: optionalDecimal(credentials.balance, 'credentials.balance', { min: 0, allowZero: true }),
      balanceCurrency: credentials.balanceCurrency ? currencyValue(credentials.balanceCurrency, 'credentials.balanceCurrency') : '',
    },
  };
}

export function normalizeSupplierAlertEnabled(input) {
  return {
    enabled: booleanValue(input.enabled, 'enabled'),
  };
}

export function hasSupplierCredentialInput(credentials = {}) {
  return Object.values(credentials).some((value) => value !== undefined && value !== null && value !== '');
}

export function mergeSupplierCredentials(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  const authenticationChanged = ['username', 'password', 'totpSecret']
    .some((key) => incoming[key] !== undefined && incoming[key] !== null
      && incoming[key] !== '' && incoming[key] !== existing[key]);
  if (authenticationChanged) {
    merged.accessToken = '';
    merged.sessionCookie = '';
    merged.userId = '';
    merged.accessTokenExpiresAt = null;
  }
  const refreshTokenChanged = incoming.refreshToken !== undefined && incoming.refreshToken !== null
    && incoming.refreshToken !== '' && incoming.refreshToken !== existing.refreshToken;
  if (refreshTokenChanged && !incoming.accessToken) {
    merged.accessToken = '';
    merged.accessTokenExpiresAt = null;
  }
  return merged;
}

export function assertSupplierCredentials(input, { existing = false } = {}) {
  const provided = hasSupplierCredentialInput(input.credentials);
  if (input.adapterType === 'openai_compatible' && input.authMode !== 'api_key') {
    throw badRequest('openai_compatible requires api_key authentication');
  }
  if (['auto', 'sub2api', 'newapi'].includes(input.adapterType) && input.authMode === 'api_key') {
    throw badRequest(`${input.adapterType} does not support api_key portal authentication`);
  }
  if (input.authMode === 'token_refresh' && input.adapterType !== 'sub2api') {
    throw badRequest('token_refresh authentication requires the sub2api adapter');
  }
  if (existing && !provided) return false;
  if (input.authMode === 'password' && (!input.credentials.username || !input.credentials.password)) {
    throw badRequest('password authentication requires username and password');
  }
  if (input.authMode === 'access_token' && !input.credentials.accessToken) {
    throw badRequest('access_token authentication requires accessToken');
  }
  if (input.authMode === 'token_refresh' && !input.credentials.refreshToken) {
    throw badRequest('token_refresh authentication requires refreshToken');
  }
  if (input.authMode === 'api_key' && !input.credentials.apiKey) {
    throw badRequest('api_key authentication requires apiKey');
  }
  return true;
}

export function normalizeSupplierQualityTarget(input) {
  return {
    keyId: optionalId(input.keyId, 'keyId') ?? (() => { throw badRequest('missing field: keyId'); })(),
    model: textValue(input.model, 'model', { max: 200 }),
    enabled: input.enabled === undefined ? true : booleanValue(input.enabled, 'enabled'),
    intervalSeconds: input.intervalSeconds === undefined
      ? 1800 : integerValue(input.intervalSeconds, 'intervalSeconds', { min: 60, max: 86400 }),
    maxOutputTokens: input.maxOutputTokens === undefined
      ? 1 : integerValue(input.maxOutputTokens, 'maxOutputTokens', { min: 1, max: 32 }),
  };
}

export function normalizeSupplierAccountLink(input) {
  return {
    accountId: optionalId(input.accountId, 'accountId') ?? (() => { throw badRequest('missing field: accountId'); })(),
    linked: booleanValue(input.linked, 'linked'),
  };
}

export function normalizeSub2ApiServiceAuthSettings(input) {
  return {
    enabled: input.enabled === undefined ? false : booleanValue(input.enabled, 'enabled'),
    authMode: optionalEnum(input.authMode, 'authMode', SUB2API_SERVICE_AUTH_MODES) || 'password',
    email: textValue(input.email, 'email', { required: false, max: 255 }),
    password: textValue(input.password, 'password', { required: false, max: 8192 }),
    totpSecret: textValue(input.totpSecret, 'totpSecret', { required: false, max: 256 }),
    apiKey: textValue(input.apiKey, 'apiKey', { required: false, max: 16384 }),
    clearCredentials: input.clearCredentials === undefined
      ? false
      : booleanValue(input.clearCredentials, 'clearCredentials'),
  };
}

export function normalizeOAuthSupplyAuthSettings(input) {
  const baseUrl = textValue(input.baseUrl || 'https://sogouedu.cc', 'baseUrl', { max: 1000 });
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { throw badRequest('invalid baseUrl'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw badRequest('baseUrl must be an HTTPS URL without credentials, query, or fragment');
  }
  return {
    enabled: input.enabled === undefined ? false : booleanValue(input.enabled, 'enabled'),
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    username: textValue(input.username, 'username', { required: false, max: 255 }),
    password: textValue(input.password, 'password', { required: false, max: 8192 }),
    clearCredentials: input.clearCredentials === undefined
      ? false
      : booleanValue(input.clearCredentials, 'clearCredentials'),
  };
}

export function normalizeAccountProfitGuard(input) {
  const rawMargin = input.minimumMargin === undefined || input.minimumMargin === ''
    ? 0
    : Number(input.minimumMargin);
  if (!Number.isFinite(rawMargin) || rawMargin < 0 || rawMargin >= 1) {
    throw badRequest('minimumMargin must be between 0 and 1');
  }
  const thresholdMode = optionalEnum(input.thresholdMode, 'thresholdMode', PROFIT_GUARD_THRESHOLD_MODES) || 'margin';
  const minimumSaleMultiplier = optionalDecimal(
    input.minimumSaleMultiplier,
    'minimumSaleMultiplier',
    { min: 0, allowZero: true },
  );
  if (thresholdMode === 'minimum_sale_multiplier' && minimumSaleMultiplier === null) {
    throw badRequest('minimumSaleMultiplier is required for minimum_sale_multiplier');
  }
  const autoAssignEnabled = input.autoAssignEnabled === undefined
    ? false
    : booleanValue(input.autoAssignEnabled, 'autoAssignEnabled');
  const marginInput = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw badRequest(`${field} must be between 0 and 1`);
    }
    return parsed;
  };
  const targetMarginMin = marginInput(input.targetMarginMin, 'targetMarginMin');
  const targetMarginMax = marginInput(input.targetMarginMax, 'targetMarginMax');
  if (autoAssignEnabled && (targetMarginMin === null || targetMarginMax === null)) {
    throw badRequest('targetMarginMin and targetMarginMax are required when autoAssignEnabled is enabled');
  }
  if (targetMarginMin !== null && targetMarginMax !== null && targetMarginMin > targetMarginMax) {
    throw badRequest('targetMarginMin must not exceed targetMarginMax');
  }
  return {
    enabled: Boolean(input.enabled),
    minimumMargin: rawMargin,
    thresholdMode,
    minimumSaleMultiplier: thresholdMode === 'minimum_sale_multiplier' ? Number(minimumSaleMultiplier) : null,
    allowEmptyGroups: input.allowEmptyGroups === undefined ? true : Boolean(input.allowEmptyGroups),
    autoAssignEnabled,
    targetMarginMin,
    targetMarginMax,
  };
}

export function normalizeAccountCostArchive(input) {
  return {
    cutoffAt: dateValue(input.cutoffAt, 'cutoffAt'),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

export function normalizeAccountCostReprice(input) {
  const effectiveFrom = dateValue(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = dateValue(input.effectiveTo, 'effectiveTo');
  if (new Date(effectiveTo) <= new Date(effectiveFrom)) throw badRequest('effectiveTo must be after effectiveFrom');
  const costMode = enumValue(input.costMode, 'costMode', COST_MODES);
  if (!['manual_multiplier', 'probe_multiplier', 'free'].includes(costMode)) {
    throw badRequest('historical cost reprice supports multiplier or free modes only');
  }
  const basisMode = optionalEnum(input.basisMode, 'basisMode', BASIS_MODES) || 'revenue_backsolve';
  const upstreamMultiplier = optionalDecimal(input.upstreamMultiplier, 'upstreamMultiplier', { min: 0, allowZero: false });
  const cnyPerReferenceUnit = optionalDecimal(input.cnyPerReferenceUnit, 'cnyPerReferenceUnit', { min: 0, allowZero: false });
  if (['manual_multiplier', 'probe_multiplier'].includes(costMode) && !upstreamMultiplier) {
    throw badRequest('historical multiplier reprice requires upstreamMultiplier');
  }
  if (costMode !== 'free' && basisMode === 'reference_cny' && !cnyPerReferenceUnit) {
    throw badRequest('reference_cny requires cnyPerReferenceUnit');
  }
  return {
    effectiveFrom,
    effectiveTo,
    costMode,
    basisMode,
    upstreamMultiplier,
    cnyPerReferenceUnit,
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

export function normalizeMonitorGroup(input) {
  const refreshIntervalSeconds = input.refreshIntervalSeconds === undefined || input.refreshIntervalSeconds === ''
    ? 60
    : integerValue(input.refreshIntervalSeconds, 'refreshIntervalSeconds', { min: 15, max: 3600 });
  const jitterSeconds = input.jitterSeconds === undefined || input.jitterSeconds === ''
    ? 0
    : integerValue(input.jitterSeconds, 'jitterSeconds', { min: 0, max: Math.max(0, refreshIntervalSeconds - 15) });
  const normalized = {
    name: textValue(input.name, 'name', { max: 120 }),
    sourceGroupId: integerValue(input.sourceGroupId, 'sourceGroupId', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    modelLabel: textValue(input.modelLabel, 'modelLabel', { required: false, max: 120 }),
    displayMultiplier: optionalDecimal(input.displayMultiplier, 'displayMultiplier', { min: 0, allowZero: false }),
    refreshIntervalSeconds,
    displayOrder: input.displayOrder === undefined || input.displayOrder === ''
      ? 0
      : integerValue(input.displayOrder, 'displayOrder', { min: 0, max: 100000 }),
    enabled: input.enabled === undefined ? true : booleanValue(input.enabled, 'enabled'),
  };
  if (Object.hasOwn(input, 'provider') || Object.hasOwn(input, 'endpoint') || Object.hasOwn(input, 'apiKey')
    || Object.hasOwn(input, 'primaryModel') || Object.hasOwn(input, 'extraModels')) {
    const provider = enumValue(input.provider || 'openai', 'provider', MONITOR_PROVIDERS);
    const apiMode = optionalEnum(input.apiMode, 'apiMode', MONITOR_API_MODES) || 'chat_completions';
    if (apiMode === 'responses' && provider !== 'openai') throw badRequest('responses api mode is only supported for openai');
    normalized.provider = provider;
    normalized.apiMode = provider === 'openai' ? apiMode : 'chat_completions';
    normalized.endpoint = monitorEndpoint(input.endpoint);
    normalized.apiKey = textValue(input.apiKey, 'apiKey', { required: false, max: 2000 });
    normalized.primaryModel = textValue(input.primaryModel, 'primaryModel', { max: 200 });
    normalized.extraModels = monitorModels(input.extraModels);
    normalized.groupName = textValue(input.groupName, 'groupName', { required: false, max: 120 });
    normalized.jitterSeconds = jitterSeconds;
    normalized.extraHeaders = monitorHeaders(input.extraHeaders);
    normalized.bodyOverrideMode = optionalEnum(input.bodyOverrideMode, 'bodyOverrideMode', MONITOR_BODY_MODES) || 'off';
    normalized.bodyOverride = monitorBody(input.bodyOverride);
    if (normalized.bodyOverrideMode !== 'off' && !Object.keys(normalized.bodyOverride).length) {
      throw badRequest(`${normalized.bodyOverrideMode} bodyOverride cannot be empty`);
    }
    if (normalized.bodyOverrideMode === 'replace') {
      validateMonitorReplaceBody(normalized.provider, normalized.apiMode, normalized.bodyOverride);
    }
  }
  return normalized;
}

export function normalizeMonitorSettings(input) {
  return {
    refreshIntervalSeconds: integerValue(
      input.refreshIntervalSeconds,
      'refreshIntervalSeconds',
      { min: 5, max: 3600 },
    ),
  };
}

export function normalizeCashTransaction(input) {
  const transactionType = enumValue(input.transactionType, 'transactionType', CASH_TYPES);
  const defaultDirection = transactionType === 'other_income' ? 'in' : 'out';
  return {
    ...cnyAmounts(input),
    transactionType,
    direction: enumValue(input.direction || defaultDirection, 'direction', DIRECTIONS),
    accountId: optionalId(input.accountId, 'accountId') ?? 0,
    paymentMethod: textValue(input.paymentMethod, 'paymentMethod', { required: false, max: 40 }) || 'Manual',
    occurredAt: dateValue(input.occurredAt, 'occurredAt'),
    reference: textValue(input.reference, 'reference', { required: false, max: 120 }),
    party: textValue(input.party, 'party', { required: false, max: 160 }),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

export function normalizeEmailSettings(input) {
  const enabled = input.enabled === undefined ? false : booleanValue(input.enabled, 'enabled');
  const smtpHost = textValue(input.smtpHost, 'smtpHost', { required: enabled, max: 255 });
  const smtpPort = integerValue(input.smtpPort || 587, 'smtpPort', { min: 1, max: 65535 });
  const smtpSecure = input.smtpSecure === undefined ? smtpPort === 465 : booleanValue(input.smtpSecure, 'smtpSecure');
  const smtpUsername = textValue(input.smtpUsername, 'smtpUsername', { required: enabled, max: 255 });
  const smtpPassword = textValue(input.smtpPassword, 'smtpPassword', { required: false, max: 8192 });
  const fromEmail = emailValue(input.fromEmail, 'fromEmail', { required: enabled });
  const fromName = textValue(input.fromName, 'fromName', { required: false, max: 160 });
  const copy = {};
  const copyFields = [
    ['footerText', 255], ['unsubscribeLabel', 80], ['subscribeLabel', 80],
    ['unsubscribedTitle', 160], ['unsubscribedDescription', 1000],
    ['subscribedTitle', 160], ['subscribedDescription', 1000],
    ['confirmUnsubscribeTitle', 160], ['confirmUnsubscribeDescription', 1000],
    ['confirmUnsubscribeButton', 80], ['confirmSubscribeTitle', 160],
    ['confirmSubscribeDescription', 1000], ['confirmSubscribeButton', 80],
  ];
  for (const [field, max] of copyFields) {
    copy[field] = textValue(input[field] ?? EMAIL_PREFERENCE_COPY_DEFAULTS[field], field, { required: false, max });
  }
  if (enabled && !smtpPassword && input.credentialsConfigured !== true) {
    throw badRequest('smtpPassword is required when no saved password exists');
  }
  return {
    enabled,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUsername,
    smtpPassword,
    fromEmail,
    fromName,
    ...copy,
    clearCredentials: input.clearCredentials === undefined ? false : booleanValue(input.clearCredentials, 'clearCredentials'),
  };
}

export function normalizeEmailCampaign(input) {
  const recipientMode = enumValue(input.recipientMode || 'all', 'recipientMode', EMAIL_RECIPIENT_MODES);
  const userIds = recipientMode === 'selected' ? idList(input.userIds, 'userIds', { max: 10000 }) : [];
  const htmlContent = String(input.htmlContent ?? '').trim();
  if (!htmlContent || htmlContent.length > 500000) throw badRequest('htmlContent is required and must be at most 500000 characters');
  return {
    subject: textValue(input.subject, 'subject', { max: 255 }),
    category: enumValue(input.category || 'announcement', 'category', EMAIL_CATEGORIES),
    htmlContent,
    textContent: textValue(input.textContent, 'textContent', { required: false, max: 500000 }),
    recipientMode,
    userIds,
  };
}
