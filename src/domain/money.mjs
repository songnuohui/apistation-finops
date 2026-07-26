import Decimal from 'decimal.js/decimal.mjs';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function decimal(value = 0) {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

export function grossProfit(revenue, cost) {
  return decimal(revenue).minus(decimal(cost));
}

export function grossMargin(revenue, cost) {
  const normalizedRevenue = decimal(revenue);
  if (normalizedRevenue.isZero()) return null;
  return normalizedRevenue.minus(decimal(cost)).div(normalizedRevenue);
}

export function allocateFixedCost(totalCost, weights) {
  const cost = decimal(totalCost);
  const normalizedWeights = weights.map(decimal);
  const totalWeight = normalizedWeights.reduce((sum, value) => sum.plus(value), decimal(0));
  if (totalWeight.isZero()) {
    return { allocations: normalizedWeights.map(() => decimal(0)), idleCost: cost };
  }

  let allocated = decimal(0);
  const allocations = normalizedWeights.map((weight, index) => {
    if (index === normalizedWeights.length - 1) return cost.minus(allocated);
    const share = cost.mul(weight).div(totalWeight);
    allocated = allocated.plus(share);
    return share;
  });
  return { allocations, idleCost: decimal(0) };
}

export function serializeMoney(value, decimals = 6) {
  return decimal(value).toDecimalPlaces(decimals).toNumber();
}
