import Decimal from 'decimal.js/decimal.mjs';

const COST_TYPES = new Set(['metered', 'prepaid', 'subscription', 'one_time', 'free', 'hybrid']);
const ALLOCATION_METHODS = new Set(['standard_cost_weight', 'token_weight', 'none']);
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

function tagValues(value) {
  if (value === undefined || value === null || value === '') return null;
  const source = Array.isArray(value) ? value : String(value).split(',');
  const tags = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  if (tags.length > 20 || tags.some((tag) => tag.length > 40)) throw badRequest('invalid tags');
  return tags;
}

export function normalizeCostProfile(input) {
  return {
    name: textValue(input.name, 'name', { max: 120 }),
    costType: enumValue(input.costType, 'costType', COST_TYPES),
    currency: cnyCurrency(input.currency, 'currency'),
    allocationMethod: enumValue(input.allocationMethod, 'allocationMethod', ALLOCATION_METHODS),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
  };
}

export function normalizeAccountCostPeriod(input) {
  const effectiveFrom = dateValue(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = dateValue(input.effectiveTo, 'effectiveTo');
  if (new Date(effectiveTo) <= new Date(effectiveFrom)) throw badRequest('effectiveTo must be after effectiveFrom');
  return {
    ...cnyAmounts(input),
    accountId: optionalId(input.accountId, 'accountId') ?? (() => { throw badRequest('missing field: accountId'); })(),
    costProfileId: optionalId(input.costProfileId, 'costProfileId'),
    feeAmount: decimalValue(input.feeAmount ?? 0, 'feeAmount'),
    taxAmount: decimalValue(input.taxAmount ?? 0, 'taxAmount'),
    effectiveFrom,
    effectiveTo,
    supplier: textValue(input.supplier, 'supplier', { required: false, max: 160 }),
    purchaseBatch: textValue(input.purchaseBatch, 'purchaseBatch', { required: false, max: 120 }),
    tags: tagValues(input.tags),
    notes: textValue(input.notes, 'notes', { required: false, max: 2000 }),
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
