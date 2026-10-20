import { describe, it, assert } from './runner.js';
import {
  toPaise, allocateByWeight, formatINR, MoneyError, assertPaise, scalePaise,
} from '../js/money.js';
import {
  createBudget, templateFor, summarise, applyExpenses, setTotalBudget,
  setCategoryAllocation, removeCategory, addCategory, projectGuestCountChange,
  setReservePercent,
} from '../js/budget-engine.js';

const weddingCats = templateFor('wedding');

function makeBudget(rupees = 500000, reservePercent = 10) {
  return createBudget({
    totalBudgetPaise: toPaise(rupees),
    categories: weddingCats,
    reservePercent,
  });
}

describe('money primitives', () => {
  it('converts rupees to integer paise', () => {
    assert.equal(toPaise(1234.56), 123456);
    assert.equal(toPaise('2500'), 250000);
    assert.equal(toPaise(0), 0);
  });

  it('rejects negative, NaN and non-finite amounts', () => {
    assert.throws(() => toPaise(-1), 'negative rejected');
    assert.throws(() => toPaise('abc'), 'NaN rejected');
    assert.throws(() => toPaise(Infinity), 'Infinity rejected');
  });

  it('avoids float drift that plain rupee maths produces', () => {
    // 0.1 + 0.2 !== 0.3 in float rupees; in paise it is exact.
    assert.equal(toPaise(0.1) + toPaise(0.2), toPaise(0.3));
    const third = toPaise(100) / 3;
    assert.ok(!Number.isInteger(third), 'raw division is not integral');
    const split = allocateByWeight(toPaise(100), [
      { key: 'a', weight: 1 }, { key: 'b', weight: 1 }, { key: 'c', weight: 1 },
    ]);
    assert.equal(split.a + split.b + split.c, toPaise(100), 'thirds still sum exactly');
  });

  it('rounds currency at the paise boundary, half away from zero', () => {
    assert.equal(toPaise(10.005), 1001);
    assert.equal(toPaise(10.004), 1000);
    assert.throws(() => assertPaise(10.5), 'fractional paise rejected downstream');
  });

  it('allocateByWeight always reconciles to the total', () => {
    for (const total of [1, 7, 99, 100001, 123456789]) {
      const res = allocateByWeight(total, weddingCats.map((c) => ({ key: c.id, weight: c.weight })));
      const sum = Object.values(res).reduce((a, b) => a + b, 0);
      assert.equal(sum, total, `allocation of ${total} must reconcile`);
    }
  });

  it('formats INR in Indian locale', () => {
    const s = formatINR(toPaise(500000));
    assert.ok(s.includes('5,00,000'), `expected lakh grouping, got ${s}`);
  });
});

describe('budget allocation totals', () => {
  it('allocations plus reserve equal the total budget exactly (I1)', () => {
    const budget = makeBudget(500000, 10);
    const sum = budget.categories.reduce((s, c) => s + c.allocatedPaise, 0);
    assert.equal(sum + budget.reservePaise, budget.totalBudgetPaise);
  });

  it('summary reconciles with the underlying categories', () => {
    const s = summarise(makeBudget(237711), { guestCount: 120 });
    assert.ok(s.reconciles, 'summary must reconcile');
    assert.equal(s.allocatedPaise + s.reservePaise + s.unallocatedPaise, s.totalBudgetPaise);
  });

  it('computes an emergency reserve at the configured percent', () => {
    const budget = makeBudget(1000000, 15);
    assert.equal(budget.reservePaise, toPaise(150000));
    const zero = makeBudget(1000000, 0);
    assert.equal(zero.reservePaise, 0);
    assert.throws(() => setReservePercent(makeBudget(), 80), 'reserve above 50% rejected');
  });

  it('keeps the total limit fixed when the reserve changes (I3)', () => {
    const before = makeBudget(400000, 10);
    const after = setReservePercent(before, 20);
    assert.equal(after.totalBudgetPaise, before.totalBudgetPaise);
    assert.equal(after.reservePaise, toPaise(80000));
  });
});

describe('expenses, overruns and per-guest costs', () => {
  it('detects spend exceeding the total budget', () => {
    let budget = makeBudget(100000);
    budget = applyExpenses(budget, [
      { categoryId: 'catering', amountPaise: toPaise(90000), kind: 'actual' },
      { categoryId: 'venue', amountPaise: toPaise(40000), kind: 'actual' },
    ]);
    const s = summarise(budget, { guestCount: 50 });
    assert.ok(s.overBudget, 'must flag over-budget');
    assert.equal(s.remainingPaise, toPaise(100000) - toPaise(130000));
    assert.ok(s.warnings.some((w) => w.code === 'over-budget'));
  });

  it('flags category overruns even when the total still fits', () => {
    let budget = makeBudget(500000);
    budget = applyExpenses(budget, [
      { categoryId: 'invitations', amountPaise: toPaise(50000), kind: 'actual' },
    ]);
    const s = summarise(budget, { guestCount: 100 });
    assert.ok(!s.overBudget, 'total is still inside budget');
    assert.ok(s.warnings.some((w) => w.code === 'category-overrun'), 'category overrun flagged');
  });

  it('rejects negative expense amounts', () => {
    assert.throws(() => applyExpenses(makeBudget(), [
      { categoryId: 'venue', amountPaise: -500, kind: 'actual' },
    ]), 'negative expense rejected');
  });

  it('rejects non-integer (float rupee) expense amounts', () => {
    assert.throws(() => applyExpenses(makeBudget(), [
      { categoryId: 'venue', amountPaise: 1234.5, kind: 'actual' },
    ]));
  });

  it('prefers actual over estimate when both exist', () => {
    let budget = makeBudget(500000);
    budget = applyExpenses(budget, [
      { categoryId: 'venue', amountPaise: toPaise(100000), kind: 'estimate' },
      { categoryId: 'venue', amountPaise: toPaise(90000), kind: 'actual' },
    ]);
    const venue = summarise(budget, { guestCount: 10 }).categories.find((c) => c.id === 'venue');
    assert.equal(venue.committedPaise, toPaise(90000));
  });

  it('handles zero guests without dividing by zero', () => {
    const s = summarise(makeBudget(200000), { guestCount: 0 });
    assert.equal(s.perGuestAllocatedPaise, null);
    assert.equal(s.perGuestCommittedPaise, null);
    assert.ok(Number.isFinite(s.allocatedPaise));
  });

  it('computes per-guest cost when guests are present', () => {
    const s = summarise(makeBudget(500000), { guestCount: 200 });
    assert.equal(s.perGuestAllocatedPaise, Math.round(s.allocatedPaise / 200));
  });
});

describe('missing and edited allocations', () => {
  it('flags categories with no allocation', () => {
    const budget = createBudget({
      totalBudgetPaise: toPaise(100000),
      reservePercent: 10,
      categories: [
        { id: 'venue', label: 'Venue', weight: 100 },
        { id: 'decor', label: 'Decor', weight: 0 },
      ],
    });
    const s = summarise(budget, { guestCount: 10 });
    assert.ok(s.warnings.some((w) => w.code === 'missing-allocation'), 'zero allocation flagged');
  });

  it('redistributes when one category is manually raised, preserving the limit', () => {
    const budget = makeBudget(500000, 10);
    const { budget: next, infeasible } = setCategoryAllocation(budget, 'catering', toPaise(200000));
    assert.ok(!infeasible);
    const sum = next.categories.reduce((s, c) => s + c.allocatedPaise, 0);
    assert.equal(sum + next.reservePaise, next.totalBudgetPaise, 'total preserved');
    assert.equal(next.categories.find((c) => c.id === 'catering').allocatedPaise, toPaise(200000));
  });

  it('refuses an allocation larger than the available budget instead of silently fixing it', () => {
    const budget = makeBudget(100000, 10);
    const { infeasible, budget: unchanged } = setCategoryAllocation(budget, 'venue', toPaise(99000));
    assert.ok(infeasible, 'must report infeasible');
    assert.equal(unchanged.totalBudgetPaise, budget.totalBudgetPaise, 'budget untouched');
  });

  it('adding and removing categories keeps reconciliation', () => {
    let budget = addCategory(makeBudget(300000), { id: 'security', label: 'Security', weight: 5 });
    let sum = budget.categories.reduce((s, c) => s + c.allocatedPaise, 0);
    assert.equal(sum + budget.reservePaise, budget.totalBudgetPaise);
    budget = removeCategory(budget, 'security');
    sum = budget.categories.reduce((s, c) => s + c.allocatedPaise, 0);
    assert.equal(sum + budget.reservePaise, budget.totalBudgetPaise);
  });

  it('setTotalBudget is the only path that changes the limit (I3)', () => {
    const before = makeBudget(500000);
    const raised = setTotalBudget(before, 700000);
    assert.equal(raised.totalBudgetPaise, toPaise(700000));
    assert.equal(before.totalBudgetPaise, toPaise(500000), 'original untouched (immutability)');
  });
});

describe('guest-count replanning', () => {
  it('scales guest-sensitive categories only', () => {
    const budget = makeBudget(500000);
    const p = projectGuestCountChange(budget, { oldGuestCount: 100, newGuestCount: 200 });
    assert.equal(p.ratio, 2);
    const ids = p.impacts.map((i) => i.categoryId);
    assert.ok(ids.includes('catering'), 'catering scales');
    assert.ok(!ids.includes('photography'), 'photography does not scale with headcount');
  });

  it('reports infeasibility instead of quietly shrinking the plan', () => {
    const budget = makeBudget(500000);
    const p = projectGuestCountChange(budget, { oldGuestCount: 100, newGuestCount: 400 });
    assert.ok(!p.feasible, 'quadrupling guests must not fit');
    assert.ok(p.shortfallPaise > 0, 'shortfall quantified');
  });

  it('handles a drop to zero guests', () => {
    const p = projectGuestCountChange(makeBudget(500000), { oldGuestCount: 100, newGuestCount: 0 });
    assert.equal(p.ratio, 0);
    assert.ok(p.feasible);
  });

  it('rejects invalid guest counts', () => {
    assert.throws(() => projectGuestCountChange(makeBudget(), { oldGuestCount: 10, newGuestCount: -5 }));
    assert.throws(() => projectGuestCountChange(makeBudget(), { oldGuestCount: 10, newGuestCount: 2.5 }));
  });

  it('scalePaise never produces fractional paise', () => {
    assert.ok(Number.isInteger(scalePaise(10001, 1 / 3)));
  });
});
