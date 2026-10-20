/**
 * money.js — integer-paise money primitives.
 *
 * Rule for the whole codebase: money is stored and computed as an integer
 * number of paise (1 INR = 100 paise). Floating point rupees are only ever
 * produced at the formatting boundary. This removes the 0.1 + 0.2 class of
 * bug from every budget total.
 */

export const PAISE_PER_RUPEE = 100;

/** Largest safe rupee amount we accept (prevents Number overflow in paise). */
export const MAX_RUPEES = 10_000_000_000; // 1,000 crore

export class MoneyError extends Error {}

/**
 * Convert a user-supplied rupee value to integer paise.
 * Accepts numbers or numeric strings. Rejects NaN, Infinity, negatives.
 */
export function toPaise(rupees, { allowNegative = false } = {}) {
  const n = typeof rupees === 'string' ? Number(rupees.trim()) : rupees;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new MoneyError(`Not a finite amount: ${String(rupees)}`);
  }
  if (!allowNegative && n < 0) {
    throw new MoneyError(`Amount cannot be negative: ${n}`);
  }
  if (Math.abs(n) > MAX_RUPEES) {
    throw new MoneyError(`Amount out of supported range: ${n}`);
  }
  // Round half away from zero at paise precision.
  const scaled = n * PAISE_PER_RUPEE;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded;
}

/** Integer paise -> Number of rupees (display only). */
export function toRupees(paise) {
  assertPaise(paise);
  return paise / PAISE_PER_RUPEE;
}

export function assertPaise(paise) {
  if (!Number.isInteger(paise)) {
    throw new MoneyError(`Paise value must be an integer: ${String(paise)}`);
  }
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`Paise value exceeds safe integer range: ${paise}`);
  }
  return paise;
}

export function addPaise(...values) {
  return values.reduce((acc, v) => {
    assertPaise(v);
    return acc + v;
  }, 0);
}

export function subtractPaise(a, b) {
  assertPaise(a);
  assertPaise(b);
  return a - b;
}

/**
 * Multiply paise by a non-negative ratio, rounding to the nearest paise.
 * Used for percentage shares and per-guest scaling.
 */
export function scalePaise(paise, ratio) {
  assertPaise(paise);
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
    throw new MoneyError(`Invalid ratio: ${String(ratio)}`);
  }
  return Math.round(paise * ratio);
}

/**
 * Split `totalPaise` across weighted buckets so the parts sum EXACTLY to the
 * total. Uses the largest-remainder (Hamilton) method: floor every share, then
 * hand the leftover paise to the buckets with the largest fractional parts.
 *
 * @param {number} totalPaise
 * @param {Array<{key: string, weight: number}>} weights
 * @returns {Record<string, number>} key -> paise
 */
export function allocateByWeight(totalPaise, weights) {
  assertPaise(totalPaise);
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new MoneyError('At least one weighted bucket is required');
  }
  const cleaned = weights.map((w) => {
    if (!w || typeof w.key !== 'string' || !w.key) {
      throw new MoneyError('Each bucket needs a string key');
    }
    const weight = Number(w.weight);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new MoneyError(`Invalid weight for ${w.key}: ${String(w.weight)}`);
    }
    return { key: w.key, weight };
  });

  const totalWeight = cleaned.reduce((s, w) => s + w.weight, 0);
  const result = {};
  if (totalWeight === 0) {
    for (const w of cleaned) result[w.key] = 0;
    return result;
  }

  const remainders = [];
  let assigned = 0;
  for (const w of cleaned) {
    const exact = (totalPaise * w.weight) / totalWeight;
    const floored = Math.floor(exact);
    result[w.key] = floored;
    assigned += floored;
    remainders.push({ key: w.key, frac: exact - floored });
  }

  let leftover = totalPaise - assigned;
  remainders.sort((a, b) => b.frac - a.frac || a.key.localeCompare(b.key));
  let i = 0;
  while (leftover > 0 && remainders.length > 0) {
    result[remainders[i % remainders.length].key] += 1;
    leftover -= 1;
    i += 1;
  }
  return result;
}

const INR_FORMAT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** Format integer paise as an Indian-locale currency string. */
export function formatINR(paise) {
  assertPaise(paise);
  return INR_FORMAT.format(paise / PAISE_PER_RUPEE);
}

/** Compact display for dashboard tiles: ₹1.2L, ₹3.4Cr. */
export function formatCompactINR(paise) {
  assertPaise(paise);
  const rupees = Math.abs(paise) / PAISE_PER_RUPEE;
  const sign = paise < 0 ? '-' : '';
  if (rupees >= 1e7) return `${sign}₹${(rupees / 1e7).toFixed(2)}Cr`;
  if (rupees >= 1e5) return `${sign}₹${(rupees / 1e5).toFixed(2)}L`;
  if (rupees >= 1e3) return `${sign}₹${(rupees / 1e3).toFixed(1)}K`;
  return `${sign}₹${rupees.toFixed(0)}`;
}

/** Percentage of `part` within `whole`, guarded against divide-by-zero. */
export function percentOf(part, whole) {
  assertPaise(part);
  assertPaise(whole);
  if (whole === 0) return 0;
  return (part / whole) * 100;
}
