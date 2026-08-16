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
const PROFIT_GUARD_THRESHOLD_MODES = new Set(['margin', 'minimum_sale_multiplier']);
const SUB2API_SERVICE_AUTH_MODES = new Set(['password', 'api_key']);

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

export function normalizeAlertNotificationSettings(input) {
  const enabled = input.enabled === undefined ? false : booleanValue(input.enabled, 'enabled');
  const qqNumber = textValue(input.qqNumber, 'qqNumber', { required: false, max: 20 });
  const onebotEndpoint = textValue(input.onebotEndpoint, 'onebotEndpoint', { required: false, max: 1000 });
  const accessToken = textValue(input.accessToken, 'accessToken', { required: false, max: 16384 });
  const clearAccessToken = input.clearAccessToken === undefined
    ? false
    : booleanValue(input.clearAccessToken, 'clearAccessToken');
  if (qqNumber && !/^\d{5,12}$/.test(qqNumber)) throw badRequest('qqNumber must contain 5 to 12 digits');
  if (onebotEndpoint) {
    let parsed;
    try { parsed = new URL(onebotEndpoint); }
    catch { throw badRequest('invalid onebotEndpoint'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw badRequest('invalid onebotEndpoint');
    }
  }
  if (enabled && (!qqNumber || !onebotEndpoint)) {
    throw badRequest('enabled QQ alerts require qqNumber and onebotEndpoint');
  }
  return { enabled, qqNumber, onebotEndpoint, accessToken, clearAccessToken };
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
  return {
    name: textValue(input.name, 'name', { max: 120 }),
    sourceGroupId: integerValue(input.sourceGroupId, 'sourceGroupId', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    modelLabel: textValue(input.modelLabel, 'modelLabel', { required: false, max: 120 }),
    displayOrder: input.displayOrder === undefined || input.displayOrder === ''
      ? 0
      : integerValue(input.displayOrder, 'displayOrder', { min: 0, max: 100000 }),
    enabled: input.enabled === undefined ? true : booleanValue(input.enabled, 'enabled'),
  };
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
