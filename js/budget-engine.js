/**
 * budget-engine.js — deterministic money. No AI output reaches this module
 * except as *weights*; every rupee below is computed here.
 *
 * Invariants enforced by the tests in tests/budget.test.js:
 *   I1  sum(category.allocated) + reserve === totalBudget   (always, exactly)
 *   I2  remaining === totalBudget - committed               (committed = actual, or estimate if no actual)
 *   I3  the user's total limit never changes unless setTotalBudget() is called
 */

import {
  addPaise,
  allocateByWeight,
  assertPaise,
  percentOf,
  scalePaise,
  toPaise,
} from './money.js';

/**
 * Default category weights per event category. Percentages are *starting
 * points based on common planning heuristics*, not market quotations.
 */
export const DEFAULT_CATEGORY_TEMPLATES = {
  wedding: [
    { id: 'venue', label: 'Venue', weight: 25 },
    { id: 'catering', label: 'Catering', weight: 30 },
    { id: 'decor', label: 'Decor & Florals', weight: 12 },
    { id: 'photography', label: 'Photography & Video', weight: 10 },
    { id: 'attire', label: 'Attire & Grooming', weight: 8 },
    { id: 'music', label: 'Music, Audio & Lighting', weight: 6 },
    { id: 'invitations', label: 'Invitations & Stationery', weight: 3 },
    { id: 'transport', label: 'Transport & Logistics', weight: 6 },
  ],
  birthday: [
    { id: 'venue', label: 'Venue', weight: 20 },
    { id: 'catering', label: 'Food & Cake', weight: 35 },
    { id: 'decor', label: 'Decor', weight: 15 },
    { id: 'entertainment', label: 'Entertainment & Activities', weight: 15 },
    { id: 'photography', label: 'Photography', weight: 8 },
    { id: 'invitations', label: 'Invitations & Favours', weight: 7 },
  ],
  engagement: [
    { id: 'venue', label: 'Venue', weight: 25 },
    { id: 'catering', label: 'Catering', weight: 30 },
    { id: 'decor', label: 'Decor & Florals', weight: 15 },
    { id: 'photography', label: 'Photography', weight: 12 },
    { id: 'attire', label: 'Attire', weight: 10 },
    { id: 'invitations', label: 'Invitations', weight: 8 },
  ],
  college: [
    { id: 'venue', label: 'Venue & Permissions', weight: 18 },
    { id: 'catering', label: 'Refreshments', weight: 22 },
    { id: 'music', label: 'Audio, Lighting & Stage', weight: 25 },
    { id: 'decor', label: 'Decor & Branding', weight: 12 },
    { id: 'speakers', label: 'Speakers / Performers', weight: 13 },
    { id: 'marketing', label: 'Publicity & Printing', weight: 10 },
  ],
  community: [
    { id: 'venue', label: 'Venue & Permits', weight: 20 },
    { id: 'catering', label: 'Food & Refreshments', weight: 32 },
    { id: 'decor', label: 'Decor & Seating', weight: 15 },
    { id: 'music', label: 'Audio & Lighting', weight: 13 },
    { id: 'volunteers', label: 'Volunteer & Safety Support', weight: 10 },
    { id: 'transport', label: 'Transport & Logistics', weight: 10 },
  ],
};

export const DEFAULT_RESERVE_PERCENT = 10;

export function templateFor(eventCategory) {
  const template = DEFAULT_CATEGORY_TEMPLATES[eventCategory];
  if (!template) return DEFAULT_CATEGORY_TEMPLATES.community.map((c) => ({ ...c }));
  return template.map((c) => ({ ...c }));
}

/**
 * Build a budget object.
 *
 * @param {object} opts
 * @param {number} opts.totalBudgetPaise
 * @param {Array<{id,label,weight}>} opts.categories
 * @param {number} opts.reservePercent  0..50
 */
export function createBudget({ totalBudgetPaise, categories, reservePercent = DEFAULT_RESERVE_PERCENT }) {
  assertPaise(totalBudgetPaise);
  if (totalBudgetPaise < 0) throw new RangeError('Total budget cannot be negative.');
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new RangeError('A budget needs at least one category.');
  }
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 50) {
    throw new RangeError('Reserve percent must be between 0 and 50.');
  }

  // Keep the reserve on a whole-rupee boundary when the budget itself is whole
  // rupees, so the allocatable remainder divides cleanly and no category ends
  // up displaying stray paise.
  const rawReserve = (totalBudgetPaise * reservePercent) / 100;
  const reservePaise = totalBudgetPaise % 100 === 0
    ? Math.round(rawReserve / 100) * 100
    : Math.round(rawReserve);
  const allocatablePaise = totalBudgetPaise - reservePaise;

  const shares = allocateByWeight(
    allocatablePaise,
    categories.map((c) => ({ key: c.id, weight: c.weight })),
  );

  return {
    totalBudgetPaise,
    reservePercent,
    reservePaise,
    categories: categories.map((c) => ({
      id: c.id,
      label: c.label || c.id,
      weight: c.weight,
      allocatedPaise: shares[c.id] ?? 0,
      estimatedPaise: 0, // quoted / expected spend
      actualPaise: 0, // money actually committed or paid
      locked: Boolean(c.locked),
    })),
  };
}

/** Re-derive allocations from weights while preserving the total limit (I3). */
export function reallocate(budget, { categories } = {}) {
  const next = categories ?? budget.categories;
  const rebuilt = createBudget({
    totalBudgetPaise: budget.totalBudgetPaise,
    reservePercent: budget.reservePercent,
    categories: next.map((c) => ({ id: c.id, label: c.label, weight: c.weight, locked: c.locked })),
  });
  // Carry forward estimates and actuals; they are facts, not derived values.
  const byId = new Map(budget.categories.map((c) => [c.id, c]));
  rebuilt.categories = rebuilt.categories.map((c) => {
    const old = byId.get(c.id);
    return old
      ? { ...c, estimatedPaise: old.estimatedPaise, actualPaise: old.actualPaise }
      : c;
  });
  return rebuilt;
}

/** Explicit, auditable change of the user's spending limit. */
export function setTotalBudget(budget, newTotalRupees) {
  const totalBudgetPaise = toPaise(newTotalRupees);
  return reallocate({ ...budget, totalBudgetPaise }, { categories: budget.categories });
}

export function setReservePercent(budget, reservePercent) {
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 50) {
    throw new RangeError('Reserve percent must be between 0 and 50.');
  }
  return reallocate({ ...budget, reservePercent }, { categories: budget.categories });
}

/**
 * Manually override one category's allocation. The difference is absorbed by
 * the unlocked categories so the total limit is preserved (I1 + I3).
 * Returns { budget, infeasible } — infeasible is true when the requested
 * amount cannot be funded without breaking the limit.
 */
export function setCategoryAllocation(budget, categoryId, newAllocationPaise) {
  assertPaise(newAllocationPaise);
  if (newAllocationPaise < 0) throw new RangeError('Allocation cannot be negative.');

  const target = budget.categories.find((c) => c.id === categoryId);
  if (!target) throw new RangeError(`Unknown budget category: ${categoryId}`);

  const others = budget.categories.filter((c) => c.id !== categoryId && !c.locked);
  const allocatable = budget.totalBudgetPaise - budget.reservePaise;
  const remainderForOthers = allocatable - newAllocationPaise;

  if (remainderForOthers < 0) {
    return { budget, infeasible: true, reason: 'That allocation exceeds the available budget after the emergency reserve.' };
  }

  const otherTotal = others.reduce((s, c) => s + c.allocatedPaise, 0);
  const redistributed = others.length === 0
    ? {}
    : allocateByWeight(
        remainderForOthers,
        others.map((c) => ({ key: c.id, weight: otherTotal > 0 ? c.allocatedPaise : 1 })),
      );

  const categories = budget.categories.map((c) => {
    if (c.id === categoryId) return { ...c, allocatedPaise: newAllocationPaise };
    if (c.id in redistributed) return { ...c, allocatedPaise: redistributed[c.id] };
    return c;
  });

  return { budget: { ...budget, categories }, infeasible: false };
}

export function addCategory(budget, { id, label, weight = 5 }) {
  if (budget.categories.some((c) => c.id === id)) return budget;
  return reallocate(budget, {
    categories: [...budget.categories, { id, label, weight }],
  });
}

export function removeCategory(budget, categoryId) {
  const categories = budget.categories.filter((c) => c.id !== categoryId);
  if (categories.length === 0) throw new RangeError('A budget needs at least one category.');
  return reallocate(budget, { categories });
}

/** Record an estimate (a quote) or an actual (money committed). */
export function applyExpenses(budget, expenses = []) {
  const estimated = new Map();
  const actual = new Map();

  for (const e of expenses) {
    if (!e || typeof e.categoryId !== 'string') continue;
    const amount = Number(e.amountPaise);
    if (!Number.isInteger(amount)) {
      throw new RangeError(`Expense amount must be integer paise: ${String(e.amountPaise)}`);
    }
    if (amount < 0) {
      throw new RangeError('Expense amounts cannot be negative. Record a refund as a separate positive credit.');
    }
    const bucket = e.kind === 'actual' ? actual : estimated;
    bucket.set(e.categoryId, (bucket.get(e.categoryId) ?? 0) + amount);
  }

  return {
    ...budget,
    categories: budget.categories.map((c) => ({
      ...c,
      estimatedPaise: estimated.get(c.id) ?? 0,
      actualPaise: actual.get(c.id) ?? 0,
    })),
  };
}

/**
 * The single source of truth for every number on the dashboard.
 *
 * "Committed" = actual spend where it exists, otherwise the estimate. This is
 * what a planner actually has to worry about, and it is what `remaining` is
 * measured against.
 */
export function summarise(budget, { guestCount = 0 } = {}) {
  const categories = budget.categories.map((c) => {
    const committedPaise = c.actualPaise > 0 ? c.actualPaise : c.estimatedPaise;
    const variancePaise = c.allocatedPaise - committedPaise;
    return {
      ...c,
      committedPaise,
      variancePaise,
      overrun: committedPaise > c.allocatedPaise,
      unallocated: c.allocatedPaise === 0,
      utilisationPercent: percentOf(committedPaise, c.allocatedPaise || 0),
    };
  });

  const allocatedPaise = addPaise(...categories.map((c) => c.allocatedPaise), 0);
  const estimatedPaise = addPaise(...categories.map((c) => c.estimatedPaise), 0);
  const actualPaise = addPaise(...categories.map((c) => c.actualPaise), 0);
  const committedPaise = addPaise(...categories.map((c) => c.committedPaise), 0);
  const remainingPaise = budget.totalBudgetPaise - committedPaise;
  const unallocatedPaise = budget.totalBudgetPaise - budget.reservePaise - allocatedPaise;

  const warnings = [];
  if (committedPaise > budget.totalBudgetPaise) {
    warnings.push({
      code: 'over-budget',
      severity: 'high',
      message: 'Committed spend exceeds the total budget.',
    });
  } else if (committedPaise > budget.totalBudgetPaise - budget.reservePaise) {
    warnings.push({
      code: 'reserve-breached',
      severity: 'medium',
      message: 'Spending has started eating into the emergency reserve.',
    });
  }
  const overrunCategories = categories.filter((c) => c.overrun);
  if (overrunCategories.length > 0) {
    warnings.push({
      code: 'category-overrun',
      severity: 'medium',
      message: `${overrunCategories.length} category/categories are over their allocation: ${overrunCategories.map((c) => c.label).join(', ')}.`,
    });
  }
  const missing = categories.filter((c) => c.allocatedPaise === 0);
  if (missing.length > 0) {
    warnings.push({
      code: 'missing-allocation',
      severity: 'low',
      message: `No money allocated to: ${missing.map((c) => c.label).join(', ')}.`,
    });
  }
  if (unallocatedPaise !== 0) {
    warnings.push({
      code: 'unallocated-funds',
      severity: 'low',
      message: `${unallocatedPaise > 0 ? 'Unallocated' : 'Over-allocated by'} funds outside the reserve.`,
    });
  }

  const perGuestAllocatedPaise = guestCount > 0 ? Math.round(allocatedPaise / guestCount) : null;
  const perGuestCommittedPaise = guestCount > 0 ? Math.round(committedPaise / guestCount) : null;

  return {
    totalBudgetPaise: budget.totalBudgetPaise,
    reservePaise: budget.reservePaise,
    reservePercent: budget.reservePercent,
    allocatedPaise,
    unallocatedPaise,
    estimatedPaise,
    actualPaise,
    committedPaise,
    remainingPaise,
    overBudget: committedPaise > budget.totalBudgetPaise,
    perGuestAllocatedPaise,
    perGuestCommittedPaise,
    guestCount,
    categories,
    warnings,
    /** I1 reconciliation check — surfaced so the UI can refuse to lie. */
    reconciles: allocatedPaise + budget.reservePaise + unallocatedPaise === budget.totalBudgetPaise,
  };
}

/**
 * What happens to per-guest-sensitive categories when the guest count changes.
 * Returns a *proposal* with explained trade-offs; it never mutates the budget.
 */
export const GUEST_SENSITIVE_CATEGORIES = new Set(['catering', 'venue', 'invitations', 'transport']);

export function projectGuestCountChange(budget, { oldGuestCount, newGuestCount }) {
  if (!Number.isInteger(newGuestCount) || newGuestCount < 0) {
    throw new RangeError('Guest count must be a non-negative integer.');
  }
  if (oldGuestCount <= 0) {
    return { ratio: null, impacts: [], feasible: true, note: 'No previous guest count to scale from.' };
  }
  const ratio = newGuestCount / oldGuestCount;
  const impacts = [];
  let projectedTotal = 0;

  for (const c of budget.categories) {
    const sensitive = GUEST_SENSITIVE_CATEGORIES.has(c.id);
    // Projections are shown to the user, so keep them on whole rupees.
    const projectedPaise = sensitive
      ? Math.round(scalePaise(c.allocatedPaise, ratio) / 100) * 100
      : c.allocatedPaise;
    projectedTotal += projectedPaise;
    if (sensitive && projectedPaise !== c.allocatedPaise) {
      impacts.push({
        categoryId: c.id,
        label: c.label,
        fromPaise: c.allocatedPaise,
        toPaise: projectedPaise,
        deltaPaise: projectedPaise - c.allocatedPaise,
      });
    }
  }

  const allocatable = budget.totalBudgetPaise - budget.reservePaise;
  const shortfallPaise = projectedTotal - allocatable;

  return {
    ratio,
    impacts,
    projectedTotalPaise: projectedTotal,
    shortfallPaise: Math.max(0, shortfallPaise),
    feasible: shortfallPaise <= 0,
    note: shortfallPaise > 0
      ? 'Scaling guest-sensitive categories at the current standard exceeds the budget. Either raise the budget or lower the per-guest standard — CelebrAI will not quietly do either.'
      : 'The change fits inside the existing budget.',
  };
}
