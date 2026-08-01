import Decimal from 'decimal.js/decimal.mjs';

const COST_TYPES = new Set(['metered', 'prepaid', 'subscription', 'one_time', 'free', 'hybrid']);
const ALLOCATION_METHODS = new Set(['standard_cost_weight', 'token_weight', 'none']);
const COST_MODES = new Set(['probe_multiplier', 'manual_multiplier', 'fixed_purchase', 'free']);
const BASIS_MODES = new Set(['revenue_backsolve', 'reference_cny']);
const COST_CHANGE_STRATEGIES = new Set(['future_only', 'current_day']);
const FIXED_ALLOCATION_STRATEGIES = new Set(['equal', 'standard_cost_weight', 'token_weight']);
const CASH_TYPES = new Set([
  'other_expense', 'other_income', 'gateway_fee', 'account_purchase', 'supplier_topup',
  'subscription_renewal', 'affiliate_rebate', 'manual_adjustment', 'refund',
]);
const DIRECTIONS = new Set(['in', 'out']);

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
    defaultSellingMultiplier: optionalDecimal(input.defaultSellingMultiplier, 'defaultSellingMultiplier', { min: 0, allowZero: false }),
    currency: cnyCurrency(input.currency, 'currency'),
    allocationMethod: enumValue(input.allocationMethod, 'allocationMethod', ALLOCATION_METHODS),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

function normalizeAccountCostPeriodFields(input, accountId) {
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
  };
}

export function normalizeAccountCostPeriod(input) {
  const accountId = optionalId(input.accountId, 'accountId') ?? (() => { throw badRequest('missing field: accountId'); })();
  return normalizeAccountCostPeriodFields(input, accountId);
}

export function normalizeAccountCostPeriodUpdate(input) {
  return normalizeAccountCostPeriodFields(input, null);
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
  const sellingMultiplier = optionalDecimal(input.sellingMultiplier, 'sellingMultiplier', { min: 0, allowZero: false });
  const cnyPerReferenceUnit = optionalDecimal(input.cnyPerReferenceUnit, 'cnyPerReferenceUnit', { min: 0, allowZero: false });
  return {
    costProfileId: optionalId(input.costProfileId, 'costProfileId'),
    costMode,
    basisMode,
    upstreamMultiplier,
    sellingMultiplier,
    cnyPerReferenceUnit,
    changeStrategy: optionalEnum(input.changeStrategy, 'changeStrategy', COST_CHANGE_STRATEGIES) || 'future_only',
    supplier: textValue(input.supplier, 'supplier', { required: false, max: 160 }),
    purchaseBatch: textValue(input.purchaseBatch, 'purchaseBatch', { required: false, max: 120 }),
    tags: tagValues(input.tags) || [],
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
  const sellingMultiplier = optionalDecimal(input.sellingMultiplier, 'sellingMultiplier', { min: 0, allowZero: false });
  const cnyPerReferenceUnit = optionalDecimal(input.cnyPerReferenceUnit, 'cnyPerReferenceUnit', { min: 0, allowZero: false });
  if (['manual_multiplier', 'probe_multiplier'].includes(costMode) && !upstreamMultiplier) {
    throw badRequest('historical multiplier reprice requires upstreamMultiplier');
  }
  if (costMode !== 'free' && basisMode === 'revenue_backsolve' && !sellingMultiplier) {
    throw badRequest('revenue_backsolve requires sellingMultiplier');
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
    sellingMultiplier,
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
