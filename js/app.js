/**
 * app.js — application controller: state, routing, rendering, replanning.
 *
 * State flows one way:
 *   state  ->  derive()  ->  render()
 * Every mutation goes through update(), which saves and re-renders. No module
 * writes to the DOM except through ui.js helpers.
 */

import {
  el, mount, card, pill, notice, stat, progressBar, emptyState, skeleton,
  bulletList, table, toast, openModal, closeModal, confirmDialog,
} from './ui.js';
import { formatINR, formatCompactINR, toPaise, toRupees, MoneyError } from './money.js';
import {
  createBudget, templateFor, summarise, applyExpenses, setTotalBudget,
  setCategoryAllocation, setReservePercent, reallocate, projectGuestCountChange,
  addCategory, removeCategory, DEFAULT_RESERVE_PERCENT,
} from './budget-engine.js';
import {
  generateTimeline, annotateTasks, setTaskStatus, timelineProgress,
  rescheduleTimeline, upcomingDeadlines, TASK_STATUSES,
} from './timeline-engine.js';
import {
  VENDOR_CATEGORIES, SHORTLIST_STATUSES, BOOKING_STATUSES, PAYMENT_STATUSES,
  createVendor, updateVendor, removeVendor, vendorsToExpenses, vendorSummary, vendorCoverage,
} from './vendor-manager.js';
import { loadState, saveState, clearState, buildExport, emptyState as blankState } from './storage.js';
import { validateEvent, validateImportedState, EVENT_CATEGORIES, parseISODate, daysBetween } from './validation.js';
import { requestPlan, isLiveModeConfigured, getProxyEndpoint, setProxyEndpoint, PlanError } from './ai-planner.js';

/* ───────────────── State ───────────────── */

let state = blankState();
let currentView = 'overview';
let planBusy = false;

const VIEWS = ['overview', 'plan', 'budget', 'timeline', 'vendors', 'settings', 'create'];

function update(patch, { save = true, rerender = true } = {}) {
  state = { ...state, ...patch };
  if (save) {
    const res = saveState(state);
    if (!res.ok) toast(res.message, res.quota ? 'warn' : 'danger', { timeout: 8000 });
  }
  if (rerender) render();
}

/** Single derivation point: budget + expenses + vendors -> live summary. */
function derive() {
  if (!state.event || !state.budget) return null;
  const expenses = [...vendorsToExpenses(state.vendors), ...state.expenses];
  let budget;
  try {
    budget = applyExpenses(state.budget, expenses);
  } catch (err) {
    toast(`Expense data problem: ${err.message}`, 'danger');
    budget = state.budget;
  }
  const summary = summarise(budget, { guestCount: state.event.guestCount });
  const tasks = annotateTasks(state.tasks);
  const progress = timelineProgress(state.tasks);
  const eventDate = parseISODate(state.event.date);
  const daysUntil = eventDate ? daysBetween(new Date(), eventDate) : null;
  return { budget, summary, tasks, progress, daysUntil };
}

/* ───────────────── Routing ───────────────── */

function setView(view) {
  if (!VIEWS.includes(view)) view = 'overview';
  currentView = view;
  for (const v of VIEWS) {
    const node = document.getElementById(`view-${v}`);
    if (node) node.hidden = v !== view;
  }
  for (const btn of document.querySelectorAll('.nav__item, .mobile-nav__item')) {
    const active = btn.dataset.view === view;
    btn.classList.toggle('is-active', active);
    if (btn.classList.contains('nav__item')) {
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
  }
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
  render();
}

/* ───────────────── Render ───────────────── */

function render() {
  renderModeBadge();
  if (!state.event) {
    // No event yet: force the creation view and hide the rest.
    for (const v of VIEWS) {
      const node = document.getElementById(`view-${v}`);
      if (node) node.hidden = v !== 'create';
    }
    return;
  }
  const d = derive();
  if (currentView === 'overview') renderOverview(d);
  if (currentView === 'plan') renderPlan(d);
  if (currentView === 'budget') renderBudget(d);
  if (currentView === 'timeline') renderTimeline(d);
  if (currentView === 'vendors') renderVendors(d);
  if (currentView === 'settings') renderSettings(d);
}

function renderModeBadge() {
  const badge = document.getElementById('modeBadge');
  const text = document.getElementById('modeBadgeText');
  const live = isLiveModeConfigured();
  badge.dataset.mode = live ? 'live' : 'demo';
  text.textContent = live
    ? 'Live mode — planning service configured'
    : 'Demo mode — no AI provider configured';
}

/* ───────────────── Overview ───────────────── */

function renderOverview({ summary, progress, tasks, daysUntil }) {
  const ev = state.event;
  document.getElementById('ovTitle').textContent = ev.name;
  const catLabel = EVENT_CATEGORIES.find((c) => c.id === ev.category)?.label ?? ev.category;
  document.getElementById('ovSub').textContent =
    `${catLabel} · ${ev.date} · ${ev.location} · ${ev.guestCount} guest(s)` +
    (daysUntil === null ? '' : daysUntil < 0 ? ` · ${Math.abs(daysUntil)} day(s) ago` : ` · ${daysUntil} day(s) to go`);

  const blocks = [];

  if (daysUntil !== null && daysUntil < 0) {
    blocks.push(notice('This event date is in the past. Timeline tasks are shown as overdue until you change the date.', 'warn', { strongPrefix: 'Past event.' }));
  }
  if (!summary.reconciles) {
    blocks.push(notice('Budget totals did not reconcile. This is a bug — do not trust the figures below until it is resolved.', 'danger'));
  }
  for (const w of summary.warnings.filter((x) => x.severity !== 'low')) {
    blocks.push(notice(w.message, w.severity === 'high' ? 'danger' : 'warn'));
  }

  const committedPct = summary.totalBudgetPaise > 0
    ? (summary.committedPaise / summary.totalBudgetPaise) * 100 : 0;

  blocks.push(el('div', { class: 'stats' }, [
    stat('Total budget', formatINR(summary.totalBudgetPaise), {
      meta: `Reserve ${summary.reservePercent}% · ${formatINR(summary.reservePaise)}`,
    }),
    stat('Committed', formatINR(summary.committedPaise), {
      meta: `${Math.round(committedPct)}% of budget`,
      tone: summary.overBudget ? 'alert' : undefined,
      bar: { percent: committedPct, tone: summary.overBudget ? 'over' : committedPct > 80 ? 'warn' : '' },
    }),
    stat('Remaining', formatINR(summary.remainingPaise), {
      meta: summary.remainingPaise < 0 ? 'Over budget' : 'Against your ceiling',
      tone: summary.remainingPaise < 0 ? 'alert' : 'good',
    }),
    stat('Per guest', summary.perGuestAllocatedPaise === null ? 'N/A' : formatINR(summary.perGuestAllocatedPaise), {
      meta: summary.perGuestAllocatedPaise === null ? 'No guests recorded' : `Allocated across ${summary.guestCount} guest(s)`,
    }),
    stat('Planning progress', `${progress.percentComplete}%`, {
      meta: `${progress.completed}/${progress.total} tasks · ${progress.overdue} overdue`,
      bar: { percent: progress.percentComplete },
      tone: progress.overdue > 0 ? undefined : 'good',
    }),
  ]));

  // Budget breakdown (compact)
  const rows = summary.categories.map((c) => el('tr', {}, [
    el('td', { text: c.label }),
    el('td', { class: 'num', text: formatINR(c.allocatedPaise) }),
    el('td', { class: 'num', text: formatINR(c.committedPaise) }),
    el('td', { class: 'num' }, [el('span', {
      text: formatINR(c.variancePaise),
      style: c.overrun ? 'color:var(--danger);font-weight:600' : '',
    })]),
    el('td', {}, [c.overrun ? pill('Over', 'danger', '▲') : c.allocatedPaise === 0 ? pill('No funds', 'warn', '!') : pill('On track', 'ok', '✓')]),
  ]));
  blocks.push(card('Budget breakdown', [
    table([
      'Category', { label: 'Allocated', numeric: true }, { label: 'Committed', numeric: true },
      { label: 'Variance', numeric: true }, 'Status',
    ], rows),
  ], { note: 'Committed = money actually booked, or the best quote you have recorded. All figures are your own numbers, not vendor quotations.' }));

  // Upcoming deadlines
  const upcoming = upcomingDeadlines(state.tasks, { limit: 5 });
  blocks.push(card('Upcoming deadlines', [
    upcoming.length === 0
      ? emptyState('Nothing outstanding', 'Every generated task is complete. Add your own if something is missing.', 'Go to timeline', () => setView('timeline'))
      : el('div', {}, upcoming.map(taskRow)),
  ], { actions: [el('button', { class: 'btn btn--sm', type: 'button', text: 'All tasks', onClick: () => setView('timeline') })] }));

  // Vendor checklist
  const requiredCats = summary.categories
    .map((c) => c.id)
    .filter((id) => VENDOR_CATEGORIES.some((v) => v.id === id));
  const coverage = vendorCoverage(state.vendors, requiredCats);
  blocks.push(card('Vendor checklist', [
    el('div', { class: 'stats' }, coverage.map((c) => el('div', { class: 'stat' }, [
      el('div', { class: 'stat__label', text: c.label }),
      el('div', { style: 'margin-top:6px' }, [
        c.booked ? pill('Booked', 'ok', '✓') : c.started ? pill('In progress', 'info', '◴') : pill('Not started', 'muted', '○'),
      ]),
    ]))),
  ], {
    note: `${vendorSummary(state.vendors).total} vendor record(s). CelebrAI does not verify businesses or availability.`,
    actions: [el('button', { class: 'btn btn--sm', type: 'button', text: 'Manage', onClick: () => setView('vendors') })],
  }));

  mount(document.getElementById('ovBody'), ...blocks);
}

/* ───────────────── AI plan view ───────────────── */

function renderPlan({ summary }) {
  const host = document.getElementById('planBody');
  const btn = document.getElementById('planGenerateBtn');
  btn.disabled = planBusy;

  if (planBusy) {
    mount(host, card('Generating plan', [
      el('p', { class: 'card__note' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Building your plan…']),
      skeleton(5),
    ]));
    return;
  }

  if (!state.plan) {
    mount(host, card(null, [
      emptyState(
        'No plan generated yet',
        'CelebrAI will propose a budget split, a working timeline, a vendor checklist and the risks worth worrying about.',
        'Generate plan',
        () => generatePlan(),
      ),
    ]));
    return;
  }

  const { source, notice: planNotice, data, generatedAt, error } = state.plan;
  const blocks = [];

  blocks.push(notice(planNotice, source === 'demo' ? 'warn' : 'info', {
    strongPrefix: source === 'demo' ? 'DEMO OUTPUT —' : 'LIVE MODEL OUTPUT —',
  }));
  if (error) blocks.push(notice(error, 'danger', { strongPrefix: 'Last live attempt failed:' }));

  blocks.push(card('Event summary', [
    el('p', { text: data.summary }),
    el('p', { class: 'card__note', text: `Generated ${new Date(generatedAt).toLocaleString('en-IN')}` }),
  ]));

  blocks.push(card('Planning assumptions', [bulletList(data.assumptions)], {
    note: 'If any of these are wrong, change the event details — the whole plan recalculates.',
  }));

  // Budget allocation derived from the plan's weights.
  blocks.push(card('Budget allocation', [
    table(['Category', { label: 'Share', numeric: true }, { label: 'Allocated', numeric: true }],
      summary.categories.map((c) => el('tr', {}, [
        el('td', { text: c.label }),
        el('td', { class: 'num', text: `${c.weight}` }),
        el('td', { class: 'num', text: formatINR(c.allocatedPaise) }),
      ]))),
  ], { note: 'The assistant supplies relative weights only. Every rupee above was computed by CelebrAI’s budget engine from your stated total.' }));

  blocks.push(card('Plan detail', [
    section('Theme & decoration recommendations', bulletList(data.themeRecommendations)),
    section('Food suggestions', bulletList(data.foodSuggestions)),
    section('Activity suggestions', bulletList(data.activitySuggestions)),
    section('Vendor checklist — what to ask for', el('div', {},
      data.vendorChecklist.map((v) => el('div', { style: 'margin-bottom:12px' }, [
        el('div', { style: 'font-weight:600;font-size:13.5px' }, [
          v.category,
          ' ',
          v.typicalLeadTimeDays !== null ? pill(`${v.typicalLeadTimeDays}d lead time`, 'muted', '◴') : null,
        ]),
        el('p', { class: 'field__hint', text: v.whatToAskFor }),
      ])))),
    section('Risks', el('div', {}, data.risks.map((r) => el('div', { style: 'margin-bottom:10px' }, [
      el('div', {}, [
        pill(r.severity, r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warn' : 'muted', r.severity === 'high' ? '▲' : '●'),
        ' ',
        el('span', { style: 'font-weight:600;font-size:13.5px', text: r.risk }),
      ]),
      r.mitigation ? el('p', { class: 'field__hint', text: `Mitigation: ${r.mitigation}` }) : null,
    ])))),
    section('Cost-saving alternatives', bulletList(data.costSavingAlternatives)),
    section('Outstanding questions', bulletList(data.outstandingQuestions)),
  ]));

  mount(host, ...blocks);
}

function section(title, body, open = false) {
  return el('details', { class: 'section', open }, [
    el('summary', {}, [el('span', { text: title })]),
    el('div', {}, [body]),
  ]);
}

async function generatePlan() {
  if (!state.event || planBusy) return;
  planBusy = true;
  setView('plan');

  const d = derive();
  let result = null;
  let error = null;

  try {
    result = await requestPlan(state.event, { budgetSummary: d?.summary });
  } catch (err) {
    error = err instanceof PlanError
      ? `${err.message}${err.details?.length ? ` (${err.details.join('; ')})` : ''}`
      : `Unexpected error: ${err.message}`;
    // Fall back to demo, clearly labelled as such.
    result = await requestPlan(state.event, { endpoint: null });
    toast('Live planning failed. Showing demo output instead — it is labelled as demo.', 'warn', { timeout: 8000 });
  }

  planBusy = false;

  // Apply the plan's weights to the budget, preserving the user's total limit.
  let budget = state.budget;
  if (result.plan.budgetWeights?.length) {
    const known = new Map(templateFor(state.event.category).map((c) => [c.id, c.label]));
    const categories = result.plan.budgetWeights.map((w) => ({
      id: w.key,
      label: known.get(w.key) ?? w.label ?? w.key,
      weight: w.weight,
    }));
    budget = reallocate(
      { ...state.budget, totalBudgetPaise: state.budget.totalBudgetPaise },
      { categories },
    );
  }

  // Merge AI-suggested tasks into the timeline without losing user progress.
  const existingTitles = new Set(state.tasks.map((t) => t.title.toLowerCase()));
  const extraTasks = (result.plan.tasks ?? []).filter((t) => !existingTitles.has(t.title.toLowerCase()));
  let tasks = state.tasks;
  if (extraTasks.length > 0) {
    const generated = generateTimeline(state.event, { extraTasks });
    tasks = [...state.tasks, ...generated.tasks.filter((t) => t.source === 'ai-suggested')];
  }

  update({
    budget,
    tasks,
    plan: { source: result.source, notice: result.notice, data: result.plan, generatedAt: new Date().toISOString(), error },
  });
  toast(result.source === 'demo' ? 'Demo plan generated.' : 'Plan generated.', result.source === 'demo' ? 'warn' : 'ok');
}

/* ───────────────── Budget view ───────────────── */

function renderBudget({ summary }) {
  const blocks = [];

  for (const w of summary.warnings) {
    blocks.push(notice(w.message, w.severity === 'high' ? 'danger' : w.severity === 'medium' ? 'warn' : 'info'));
  }

  blocks.push(card('Replanning controls', [
    el('div', { class: 'form__grid' }, [
      replanField('Total budget (₹)', 'number', toRupees(summary.totalBudgetPaise), 'Change your ceiling. Allocations rescale; estimates and actuals are kept.', (val) => {
        try {
          const next = setTotalBudget(state.budget, val);
          update({ budget: next, event: { ...state.event, budget: Number(val) } });
          toast(`Budget limit changed to ${formatINR(next.totalBudgetPaise)}.`, 'ok');
        } catch (err) {
          toast(err instanceof MoneyError ? err.message : 'Could not change the budget.', 'danger');
        }
      }),
      replanField('Emergency reserve (%)', 'number', summary.reservePercent, 'Held back from every category.', (val) => {
        const pct = Number(val);
        try {
          update({ budget: setReservePercent(state.budget, pct) });
          toast(`Reserve set to ${pct}%.`, 'ok');
        } catch (err) { toast(err.message, 'danger'); }
      }),
      replanField('Guest count', 'number', state.event.guestCount, 'Scales catering, venue, invitations and transport.', (val) => handleGuestChange(Number(val))),
      replanField('Event date', 'date', state.event.date, 'Every task deadline shifts with it.', (val) => handleDateChange(val)),
    ]),
  ], { note: 'CelebrAI will tell you when a change does not fit. It will never quietly reduce your standards or raise your ceiling to make the numbers work.' }));

  const rows = summary.categories.map((c) => el('tr', {}, [
    el('td', {}, [
      el('div', { style: 'font-weight:600', text: c.label }),
      el('div', { class: 'field__hint', text: `Weight ${c.weight}` }),
    ]),
    el('td', { class: 'num', text: formatINR(c.allocatedPaise) }),
    el('td', { class: 'num', text: formatINR(c.estimatedPaise) }),
    el('td', { class: 'num', text: formatINR(c.actualPaise) }),
    el('td', { class: 'num' }, [el('span', {
      text: formatINR(c.variancePaise),
      style: c.overrun ? 'color:var(--danger);font-weight:600' : '',
    })]),
    el('td', {}, [
      el('div', { class: 'task__controls' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Adjust',
          'aria-label': `Adjust allocation for ${c.label}`,
          onClick: () => openAllocationDialog(c),
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Expense',
          'aria-label': `Record an expense for ${c.label}`,
          onClick: () => openExpenseDialog(c),
        }),
      ]),
    ]),
  ]));

  blocks.push(card('Category allocations', [
    table([
      'Category', { label: 'Allocated', numeric: true }, { label: 'Estimated', numeric: true },
      { label: 'Actual', numeric: true }, { label: 'Variance', numeric: true }, 'Actions',
    ], rows),
    el('div', { style: 'margin-top:16px;display:flex;gap:8px;flex-wrap:wrap' }, [
      el('button', { class: 'btn btn--sm', type: 'button', text: '+ Add category', onClick: openAddCategoryDialog }),
    ]),
  ], {
    note: `Allocated ${formatINR(summary.allocatedPaise)} + reserve ${formatINR(summary.reservePaise)} + unallocated ${formatINR(summary.unallocatedPaise)} = ${formatINR(summary.totalBudgetPaise)}.`,
  }));

  if (state.expenses.length > 0) {
    blocks.push(card('Manual expenses', [
      table(['Category', 'Kind', { label: 'Amount', numeric: true }, 'Note', ''],
        state.expenses.map((e, i) => el('tr', {}, [
          el('td', { text: summary.categories.find((c) => c.id === e.categoryId)?.label ?? e.categoryId }),
          el('td', {}, [e.kind === 'actual' ? pill('Actual', 'ok', '✓') : pill('Estimate', 'info', '≈')]),
          el('td', { class: 'num', text: formatINR(e.amountPaise) }),
          el('td', { text: e.note ?? '' }),
          el('td', {}, [el('button', {
            class: 'btn btn--sm btn--danger', type: 'button', text: 'Remove',
            'aria-label': `Remove expense of ${formatINR(e.amountPaise)}`,
            onClick: () => update({ expenses: state.expenses.filter((_, j) => j !== i) }),
          })]),
        ]))),
    ]));
  }

  mount(document.getElementById('budgetBody'), ...blocks);
}

function replanField(label, type, value, hint, onCommit) {
  const id = `replan-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const input = el('input', { id, type, value: String(value), min: type === 'number' ? '0' : null });
  return el('div', { class: 'field' }, [
    el('label', { for: id, text: label }),
    el('div', { style: 'display:flex;gap:8px' }, [
      input,
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Apply',
        onClick: () => onCommit(input.value),
      }),
    ]),
    el('p', { class: 'field__hint', text: hint }),
  ]);
}

function openAllocationDialog(category) {
  const input = el('input', { type: 'number', min: '0', step: '1', value: String(toRupees(category.allocatedPaise)), id: 'allocInput' });
  openModal({
    title: `Adjust ${category.label}`,
    body: [
      el('p', { class: 'field__hint', text: 'Other unlocked categories absorb the difference so your total limit is preserved. If the amount does not fit, CelebrAI refuses the change rather than silently adjusting something else.' }),
      el('label', { for: 'allocInput', text: 'Allocation (₹)', style: 'font-size:13px;font-weight:600' }),
      input,
    ],
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Apply',
        onClick: () => {
          try {
            const res = setCategoryAllocation(state.budget, category.id, toPaise(input.value));
            if (res.infeasible) { toast(res.reason, 'danger', { timeout: 8000 }); return; }
            closeModal();
            update({ budget: res.budget });
            toast(`${category.label} set to ${formatINR(toPaise(input.value))}.`, 'ok');
          } catch (err) {
            toast(err instanceof MoneyError ? err.message : 'Invalid amount.', 'danger');
          }
        },
      }),
    ],
  });
}

function openExpenseDialog(category) {
  const amount = el('input', { type: 'number', min: '0', step: '1', id: 'expAmount' });
  const kind = el('select', { id: 'expKind' }, [
    el('option', { value: 'estimate', text: 'Estimate (a quote you received)' }),
    el('option', { value: 'actual', text: 'Actual (money committed or paid)' }),
  ]);
  const note = el('input', { type: 'text', id: 'expNote', maxlength: '120' });
  openModal({
    title: `Record expense — ${category.label}`,
    body: [
      el('label', { for: 'expAmount', text: 'Amount (₹)', style: 'font-size:13px;font-weight:600' }), amount,
      el('label', { for: 'expKind', text: 'Kind', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), kind,
      el('label', { for: 'expNote', text: 'Note', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), note,
      el('p', { class: 'field__hint', text: 'Amounts you enter are treated as your own figures. CelebrAI never presents them as confirmed quotations.' }),
    ],
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Record',
        onClick: () => {
          try {
            const amountPaise = toPaise(amount.value);
            closeModal();
            update({ expenses: [...state.expenses, { categoryId: category.id, amountPaise, kind: kind.value, note: note.value.slice(0, 120) }] });
            toast('Expense recorded.', 'ok');
          } catch (err) {
            toast(err instanceof MoneyError ? err.message : 'Invalid amount.', 'danger');
          }
        },
      }),
    ],
  });
}

function openAddCategoryDialog() {
  const label = el('input', { type: 'text', id: 'catLabel', maxlength: '40' });
  const weight = el('input', { type: 'number', id: 'catWeight', min: '0', max: '100', value: '5' });
  openModal({
    title: 'Add budget category',
    body: [
      el('label', { for: 'catLabel', text: 'Name', style: 'font-size:13px;font-weight:600' }), label,
      el('label', { for: 'catWeight', text: 'Weight', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), weight,
      el('p', { class: 'field__hint', text: 'Adding a category rescales every other allocation. Your total limit does not change.' }),
    ],
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Add',
        onClick: () => {
          const name = label.value.trim();
          if (!name) { toast('Give the category a name.', 'danger'); return; }
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
          closeModal();
          update({ budget: addCategory(state.budget, { id, label: name, weight: Number(weight.value) || 1 }) });
          toast(`Added ${name}.`, 'ok');
        },
      }),
    ],
  });
}

/* ───────────────── Replanning handlers ───────────────── */

function handleGuestChange(newGuestCount) {
  if (!Number.isInteger(newGuestCount) || newGuestCount < 0) {
    toast('Guest count must be a whole number of zero or more.', 'danger');
    return;
  }
  const old = state.event.guestCount;
  if (newGuestCount === old) return;

  let projection;
  try {
    projection = projectGuestCountChange(state.budget, { oldGuestCount: old, newGuestCount });
  } catch (err) { toast(err.message, 'danger'); return; }

  const impactRows = projection.impacts.map((i) => el('tr', {}, [
    el('td', { text: i.label }),
    el('td', { class: 'num', text: formatINR(i.fromPaise) }),
    el('td', { class: 'num', text: formatINR(i.toPaise) }),
    el('td', { class: 'num', text: `${i.deltaPaise >= 0 ? '+' : ''}${formatINR(i.deltaPaise)}` }),
  ]));

  const body = [
    el('p', { text: `Changing ${old} guest(s) to ${newGuestCount} scales the guest-sensitive categories at your current per-head standard.` }),
    impactRows.length > 0
      ? table(['Category', { label: 'Now', numeric: true }, { label: 'Projected', numeric: true }, { label: 'Change', numeric: true }], impactRows)
      : el('p', { class: 'field__hint', text: 'No guest-sensitive category is affected.' }),
    notice(projection.note, projection.feasible ? 'ok' : 'danger'),
  ];
  if (!projection.feasible) {
    body.push(el('p', { class: 'field__hint', text: `Shortfall: ${formatINR(projection.shortfallPaise)}. Your options: raise the total budget, cut the guest list, or accept a lower per-head standard. CelebrAI will not pick one for you.` }));
  }
  if (state.event.nonNegotiables) {
    body.push(notice(`Preserved unchanged: ${state.event.nonNegotiables}`, 'info', { strongPrefix: 'Non-negotiables.' }));
  }

  openModal({
    title: 'Confirm guest-count change',
    body,
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button',
        text: projection.feasible ? 'Apply change' : 'Apply anyway (keeps my budget ceiling)',
        onClick: () => {
          closeModal();
          const event = { ...state.event, guestCount: newGuestCount };
          // Allocations are NOT silently inflated: the limit holds, the
          // per-head standard absorbs the change, and the warning stays visible.
          update({ event });
          toast(
            projection.feasible
              ? `Guest count updated to ${newGuestCount}.`
              : `Guest count updated to ${newGuestCount}. Your budget ceiling was preserved, so per-head spend has dropped. Review the catering and venue standard.`,
            projection.feasible ? 'ok' : 'warn',
            { timeout: 9000 },
          );
        },
      }),
    ],
  });
}

function handleDateChange(newDate) {
  const check = validateEvent({ ...state.event, date: newDate });
  if (check.errors.date) { toast(check.errors.date, 'danger'); return; }
  try {
    const { tasks, daysUntilEvent } = rescheduleTimeline(state.tasks, { newEventDate: newDate });
    update({ event: { ...state.event, date: newDate }, tasks });
    const overdue = timelineProgress(tasks).overdue;
    toast(
      daysUntilEvent < 0
        ? `Date moved to ${newDate}. That is in the past — every task is now overdue.`
        : `Date moved to ${newDate}. ${tasks.length} deadline(s) recalculated${overdue ? `, ${overdue} now overdue` : ''}.`,
      daysUntilEvent < 0 ? 'warn' : 'ok',
      { timeout: 8000 },
    );
  } catch (err) {
    toast(err.message, 'danger');
  }
}

/* ───────────────── Timeline view ───────────────── */

function renderTimeline({ tasks, progress, daysUntil }) {
  const blocks = [];

  if (daysUntil !== null && daysUntil >= 0 && daysUntil <= 21) {
    blocks.push(notice(`Short-notice mode: ${daysUntil} day(s) to the event. Lead times were compressed on generation. Expect reduced vendor choice and premium pricing.`, 'warn'));
  }
  if (progress.overdue > 0) {
    blocks.push(notice(`${progress.overdue} task(s) are past their deadline.`, 'danger'));
  }
  if (progress.blocked > 0) {
    blocks.push(notice(`${progress.blocked} task(s) are blocked by an incomplete dependency.`, 'warn'));
  }

  blocks.push(el('div', { class: 'stats' }, [
    stat('Tasks', String(progress.total), { meta: `${progress.completed} complete` }),
    stat('Progress', `${progress.percentComplete}%`, { bar: { percent: progress.percentComplete } }),
    stat('Overdue', String(progress.overdue), { tone: progress.overdue > 0 ? 'alert' : 'good' }),
    stat('Blocked', String(progress.blocked), { tone: progress.blocked > 0 ? undefined : 'good' }),
  ]));

  blocks.push(card('All tasks', [
    tasks.length === 0
      ? emptyState('No tasks yet', 'Generate a plan to build a timeline from your event date backwards.', 'Generate plan', () => generatePlan())
      : el('div', {}, tasks.map(taskRow)),
    el('div', { style: 'margin-top:16px' }, [
      el('button', { class: 'btn btn--sm', type: 'button', text: '+ Add task', onClick: openAddTaskDialog }),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Regenerate timeline',
        style: 'margin-left:8px',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Regenerate timeline?',
            message: 'This rebuilds the task list from your event date. Statuses you have set will be lost.',
            confirmLabel: 'Regenerate', danger: true,
          });
          if (!ok) return;
          const { tasks: fresh, notes } = generateTimeline(state.event);
          update({ tasks: fresh });
          toast(notes[0] ?? `${fresh.length} tasks regenerated.`, 'ok');
        },
      }),
    ]),
  ]));

  mount(document.getElementById('timelineBody'), ...blocks);
}

function taskRow(t) {
  const statusSelect = el('select', {
    'aria-label': `Status for ${t.title}`,
    onChange: (e) => {
      update({ tasks: setTaskStatus(state.tasks, t.id, e.target.value) });
    },
  }, TASK_STATUSES.map((s) => el('option', { value: s, text: statusLabel(s), selected: s === t.status })));

  const classes = ['task'];
  if (t.overdue) classes.push('is-overdue');
  else if (t.effectiveStatus === 'blocked') classes.push('is-blocked');
  if (t.status === 'completed') classes.push('is-done');

  return el('div', { class: classes.join(' ') }, [
    el('span', { 'aria-hidden': 'true', style: 'font-size:16px;color:var(--ink-3)', text: t.priority === 'high' ? '▲' : t.priority === 'low' ? '▽' : '●' }),
    el('div', {}, [
      el('div', { class: 'task__title', text: t.title }),
      el('div', { class: 'task__meta' }, [
        el('span', { text: `Due ${t.deadline}` }),
        el('span', { text: t.daysRemaining === null ? '' : t.daysRemaining < 0 ? `${Math.abs(t.daysRemaining)}d overdue` : `${t.daysRemaining}d left` }),
        el('span', { text: `${t.priority} priority` }),
        t.budgetCategory ? el('span', { text: `budget: ${t.budgetCategory}` }) : null,
        t.source === 'ai-suggested' ? el('span', { text: 'AI-suggested' }) : null,
      ]),
      t.unmetDependencies?.length
        ? el('div', { class: 'field__hint', text: `Blocked by: ${t.unmetDependencies.map((d) => d.title).join(', ')}` })
        : null,
      t.description ? el('div', { class: 'field__hint', text: t.description }) : null,
    ]),
    el('div', { class: 'task__controls' }, [
      t.overdue ? pill('Overdue', 'danger', '▲') : null,
      t.effectiveStatus === 'blocked' && !t.overdue ? pill('Blocked', 'warn', '⛔') : null,
      t.status === 'completed' ? pill('Done', 'ok', '✓') : null,
      statusSelect,
    ]),
  ]);
}

function statusLabel(s) {
  return { pending: 'Pending', 'in-progress': 'In progress', completed: 'Completed', blocked: 'Blocked' }[s] ?? s;
}

function openAddTaskDialog() {
  const title = el('input', { type: 'text', id: 'taskTitle', maxlength: '120' });
  const date = el('input', { type: 'date', id: 'taskDate', value: state.event.date });
  const priority = el('select', { id: 'taskPriority' }, [
    el('option', { value: 'high', text: 'High' }),
    el('option', { value: 'medium', text: 'Medium', selected: true }),
    el('option', { value: 'low', text: 'Low' }),
  ]);
  openModal({
    title: 'Add task',
    body: [
      el('label', { for: 'taskTitle', text: 'Title', style: 'font-size:13px;font-weight:600' }), title,
      el('label', { for: 'taskDate', text: 'Deadline', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), date,
      el('label', { for: 'taskPriority', text: 'Priority', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), priority,
    ],
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Add',
        onClick: () => {
          const name = title.value.trim();
          if (!name) { toast('Task needs a title.', 'danger'); return; }
          if (!parseISODate(date.value)) { toast('Pick a valid deadline.', 'danger'); return; }
          const eventDate = parseISODate(state.event.date);
          const deadlineDate = parseISODate(date.value);
          closeModal();
          update({
            tasks: [...state.tasks, {
              id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              templateKey: null, title: name, description: '',
              deadline: date.value,
              daysBefore: Math.max(0, daysBetween(deadlineDate, eventDate)),
              priority: priority.value, status: 'pending', dependsOn: [],
              budgetCategory: null, source: 'user',
            }],
          });
          toast('Task added.', 'ok');
        },
      }),
    ],
  });
}

/* ───────────────── Vendors view ───────────────── */

function renderVendors() {
  const blocks = [];
  const s = vendorSummary(state.vendors);

  blocks.push(notice('CelebrAI has no vendor directory and no availability feed. Every record here is something you entered or a category checklist — never a verified business, a confirmed quotation or a checked booking slot.', 'warn', { strongPrefix: 'Read this once.' }));

  blocks.push(el('div', { class: 'stats' }, [
    stat('Records', String(s.total)),
    stat('Shortlisted', String(s.shortlisted)),
    stat('Booked', String(s.booked), { tone: s.booked > 0 ? 'good' : undefined }),
    stat('Unverified', String(s.unverified), { meta: 'Not confirmed by you' }),
  ]));

  if (state.vendors.length === 0) {
    blocks.push(card(null, [emptyState('No vendors yet', 'Add the ones you are actually talking to. Record quoted costs here and they flow straight into the budget.', 'Add vendor', openVendorDialog)]));
  } else {
    const rows = state.vendors.map((v) => el('tr', {}, [
      el('td', {}, [
        el('div', { style: 'font-weight:600', text: v.name }),
        el('div', { class: 'field__hint', text: v.contact || 'No contact recorded' }),
        v.verification === 'unverified-suggestion' ? pill('Unverified', 'warn', '!') : pill('You confirmed', 'ok', '✓'),
      ]),
      el('td', { text: VENDOR_CATEGORIES.find((c) => c.id === v.categoryId)?.label ?? v.categoryId }),
      el('td', { class: 'num', text: v.quotedCostPaise === null ? '—' : formatINR(v.quotedCostPaise) }),
      el('td', {}, [selectFor(v, 'shortlistStatus', SHORTLIST_STATUSES)]),
      el('td', {}, [selectFor(v, 'bookingStatus', BOOKING_STATUSES)]),
      el('td', {}, [selectFor(v, 'paymentStatus', PAYMENT_STATUSES)]),
      el('td', {}, [
        el('div', { class: 'task__controls' }, [
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Edit', 'aria-label': `Edit ${v.name}`, onClick: () => openVendorDialog(v) }),
          el('button', {
            class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete', 'aria-label': `Delete ${v.name}`,
            onClick: async () => {
              const ok = await confirmDialog({ title: 'Delete vendor?', message: `Remove "${v.name}" and its quoted cost from the budget?`, confirmLabel: 'Delete', danger: true });
              if (ok) { update({ vendors: removeVendor(state.vendors, v.id) }); toast('Vendor removed.', 'ok'); }
            },
          }),
        ]),
      ]),
    ]));

    blocks.push(card('Vendor records', [
      table(['Vendor', 'Category', { label: 'Quoted', numeric: true }, 'Shortlist', 'Booking', 'Payment', ''], rows),
    ], { note: 'Quoted costs feed the budget: booked vendors count as actual spend, everything else as an estimate.' }));
  }

  mount(document.getElementById('vendorsBody'), ...blocks);
}

function selectFor(vendor, field, options) {
  return el('select', {
    'aria-label': `${field.replace('Status', '')} status for ${vendor.name}`,
    onChange: (e) => {
      try {
        update({ vendors: updateVendor(state.vendors, vendor.id, { [field]: e.target.value }) });
      } catch (err) { toast(err.message, 'danger'); }
    },
  }, options.map((o) => el('option', { value: o, text: humanise(o), selected: o === vendor[field] })));
}

function humanise(s) {
  return String(s).replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function openVendorDialog(existing = null) {
  const v = existing && existing.id ? existing : null;
  const name = el('input', { type: 'text', id: 'vName', maxlength: '120', value: v?.name ?? '' });
  const cat = el('select', { id: 'vCat' }, VENDOR_CATEGORIES.map((c) => el('option', { value: c.id, text: c.label, selected: c.id === v?.categoryId })));
  const cost = el('input', { type: 'number', id: 'vCost', min: '0', step: '1', value: v?.quotedCostPaise != null ? String(toRupees(v.quotedCostPaise)) : '' });
  const contact = el('input', { type: 'text', id: 'vContact', maxlength: '160', value: v?.contact ?? '' });
  const notes = el('textarea', { id: 'vNotes', rows: '2', maxlength: '1000' });
  notes.value = v?.notes ?? '';
  const confirmed = el('input', { type: 'checkbox', id: 'vConfirmed', checked: v?.verification === 'user-confirmed', style: 'width:auto;min-height:0' });

  openModal({
    title: v ? `Edit ${v.name}` : 'Add vendor',
    body: [
      el('label', { for: 'vName', text: 'Vendor name', style: 'font-size:13px;font-weight:600' }), name,
      el('label', { for: 'vCat', text: 'Category', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), cat,
      el('label', { for: 'vCost', text: 'Quoted cost (₹)', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), cost,
      el('p', { class: 'field__hint', text: 'Whatever the vendor told you. CelebrAI records it as your figure, not as a verified quotation.' }),
      el('label', { for: 'vContact', text: 'Contact note', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), contact,
      el('label', { for: 'vNotes', text: 'Notes', style: 'font-size:13px;font-weight:600;margin-top:12px;display:block' }), notes,
      el('label', { for: 'vConfirmed', style: 'font-size:13px;font-weight:600;margin-top:12px;display:flex;gap:8px;align-items:center' }, [
        confirmed, el('span', { text: 'I have contacted this vendor and confirmed they exist' }),
      ]),
    ],
    actions: [
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onClick: closeModal }),
      el('button', {
        class: 'btn btn--primary', type: 'button', text: v ? 'Save' : 'Add',
        onClick: () => {
          try {
            const payload = {
              name: name.value, categoryId: cat.value, quotedCost: cost.value,
              contact: contact.value, notes: notes.value,
              verification: confirmed.checked ? 'user-confirmed' : 'unverified-suggestion',
            };
            if (v) {
              closeModal();
              update({ vendors: updateVendor(state.vendors, v.id, payload) });
              toast('Vendor updated.', 'ok');
            } else {
              if (!payload.name.trim()) { toast('Vendor needs a name.', 'danger'); return; }
              const record = createVendor(payload);
              closeModal();
              update({ vendors: [...state.vendors, record] });
              toast('Vendor added.', 'ok');
            }
          } catch (err) {
            toast(err instanceof MoneyError ? err.message : `Could not save: ${err.message}`, 'danger');
          }
        },
      }),
    ],
  });
}

/* ───────────────── Settings view ───────────────── */

function renderSettings() {
  const endpointInput = el('input', { type: 'url', id: 'proxyUrl', value: getProxyEndpoint() ?? '', placeholder: '/api/plan or https://your-proxy.example/plan' });

  const blocks = [
    card('AI planning service', [
      notice(
        'A browser cannot keep an API key secret. Anything shipped to the browser is readable by anyone who opens devtools. CelebrAI therefore never accepts an API key here — it only accepts the URL of a server you control, which holds the key and forwards the request. A ready-made proxy is in server/proxy.js.',
        'info', { strongPrefix: 'Why there is no API-key box.' },
      ),
      el('div', { class: 'field' }, [
        el('label', { for: 'proxyUrl', text: 'Planning service endpoint' }),
        endpointInput,
        el('p', { class: 'field__hint', text: 'Leave empty to stay in demo mode. Demo output is always labelled as demo.' }),
      ]),
      el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--primary', type: 'button', text: 'Save endpoint',
          onClick: () => {
            setProxyEndpoint(endpointInput.value.trim());
            render();
            toast(endpointInput.value.trim() ? 'Endpoint saved. Live mode enabled.' : 'Endpoint cleared. Demo mode.', 'ok');
          },
        }),
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: 'Clear',
          onClick: () => { setProxyEndpoint(null); endpointInput.value = ''; render(); toast('Back to demo mode.', 'ok'); },
        }),
      ]),
    ]),

    card('Export & import', [
      el('p', { class: 'card__note', text: 'Exports contain your event, budget, tasks and vendors. Credential-shaped fields are structurally excluded from the file.' }),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        el('button', { class: 'btn btn--primary', type: 'button', text: 'Export plan (JSON)', onClick: exportPlan }),
        el('label', { class: 'btn', for: 'importFile', text: 'Import plan…', style: 'display:inline-flex;align-items:center' }),
        el('input', {
          type: 'file', id: 'importFile', accept: 'application/json,.json', class: 'sr-only',
          onChange: (e) => importPlan(e.target.files?.[0]),
        }),
      ]),
    ]),

    card('Local data', [
      el('p', { class: 'card__note', text: `Stored in this browser only. Last saved: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString('en-IN') : 'not yet'}.` }),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--danger', type: 'button', text: 'Delete all local data',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Delete everything?',
              message: 'This permanently removes your event, budget, tasks and vendor records from this browser. Export first if you want a copy. This cannot be undone.',
              confirmLabel: 'Delete permanently', danger: true,
            });
            if (!ok) return;
            const res = clearState();
            if (!res.ok) { toast(res.message, 'danger'); return; }
            state = blankState();
            setView('create');
            document.getElementById('eventForm').reset();
            toast('Local data deleted.', 'ok');
          },
        }),
      ]),
    ]),

    card('What CelebrAI does not do', [
      bulletList([
        'It does not contact vendors, check availability or obtain quotations.',
        'It does not know real prices in your city. Figures come from your budget and your entries.',
        'It does not book, pay or sign anything.',
        'It does not send your data anywhere unless you configure a planning endpoint yourself.',
        'Demo output is produced by a rule engine, not a language model, and is always labelled.',
      ]),
    ]),
  ];

  mount(document.getElementById('settingsBody'), ...blocks);
}

function exportPlan() {
  try {
    const payload = buildExport(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `celebrai-${slug(state.event?.name ?? 'event')}-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Plan exported.', 'ok');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'danger');
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';
}

async function importPlan(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large to be a CelebrAI export.', 'danger'); return; }
  let text;
  try { text = await file.text(); } catch (err) { toast(`Could not read the file: ${err.message}`, 'danger'); return; }

  const check = validateImportedState(text);
  if (!check.ok) {
    openModal({
      title: 'Import rejected',
      body: [
        el('p', { text: 'The file did not pass validation, so nothing was changed:' }),
        bulletList(check.errors),
      ],
      actions: [el('button', { class: 'btn btn--primary', type: 'button', text: 'Close', onClick: closeModal })],
    });
    return;
  }

  const ok = await confirmDialog({
    title: 'Replace current event?',
    message: 'Importing overwrites the event currently in this browser. Export it first if you want to keep it.',
    confirmLabel: 'Import and replace', danger: true,
  });
  if (!ok) return;

  const v = check.value;
  const budget = v.budget && Array.isArray(v.budget.categories) && v.budget.categories.length > 0
    ? v.budget
    : buildBudgetFor(v.event);

  state = {
    ...blankState(),
    event: v.event,
    budget,
    expenses: v.expenses,
    tasks: v.tasks.length > 0 ? v.tasks : generateTimeline(v.event).tasks,
    vendors: v.vendors,
    plan: v.plan,
  };
  update({}, { save: true });
  setView('overview');
  toast('Plan imported.', 'ok');
}

/* ───────────────── Event creation ───────────────── */

function buildBudgetFor(event) {
  return createBudget({
    totalBudgetPaise: toPaise(event.budget),
    categories: templateFor(event.category),
    reservePercent: event.reservePercent ?? DEFAULT_RESERVE_PERCENT,
  });
}

const FIELD_ERROR_IDS = {
  name: 'e-name', category: 'e-category', date: 'e-date', location: 'e-location',
  guestCount: 'e-guests', budget: 'e-budget', reservePercent: 'e-reserve',
};

function showFieldErrors(errors) {
  for (const [field, errorId] of Object.entries(FIELD_ERROR_IDS)) {
    const errNode = document.getElementById(errorId);
    const input = errNode?.closest('.field')?.querySelector('input, select, textarea');
    const message = errors[field] ?? '';
    if (errNode) errNode.textContent = message;
    errNode?.closest('.field')?.classList.toggle('has-error', Boolean(message));
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
}

function readForm() {
  const f = document.getElementById('eventForm');
  const get = (id) => f.querySelector(id)?.value ?? '';
  return {
    name: get('#f-name'), category: get('#f-category'), date: get('#f-date'),
    location: get('#f-location'), guestCount: get('#f-guests'), budget: get('#f-budget'),
    reservePercent: get('#f-reserve'), theme: get('#f-theme'), cultural: get('#f-cultural'),
    dietary: get('#f-dietary'), accessibility: get('#f-accessibility'),
    nonNegotiables: get('#f-nonneg'), optionalPreferences: get('#f-optional'),
  };
}

function fillForm(event) {
  const f = document.getElementById('eventForm');
  const set = (sel, val) => { const n = f.querySelector(sel); if (n) n.value = val ?? ''; };
  set('#f-name', event.name); set('#f-category', event.category); set('#f-date', event.date);
  set('#f-location', event.location); set('#f-guests', event.guestCount); set('#f-budget', event.budget);
  set('#f-reserve', event.reservePercent); set('#f-theme', event.theme); set('#f-cultural', event.cultural);
  set('#f-dietary', event.dietary); set('#f-accessibility', event.accessibility);
  set('#f-nonneg', event.nonNegotiables); set('#f-optional', event.optionalPreferences);
}

async function onSubmitEvent(e) {
  e.preventDefault();
  const raw = readForm();
  const check = validateEvent(raw);
  showFieldErrors(check.errors);

  const warnHost = document.getElementById('formWarnings');
  mount(warnHost, ...check.warnings.map((w) => notice(w.message, 'warn')));

  if (!check.ok) {
    const firstError = Object.keys(check.errors)[0];
    document.getElementById(FIELD_ERROR_IDS[firstError])?.closest('.field')?.querySelector('input, select')?.focus();
    toast('Fix the highlighted fields.', 'danger');
    return;
  }

  const event = check.value;
  const isEdit = Boolean(state.event);

  let budget;
  try {
    budget = isEdit
      ? setTotalBudget(setReservePercent(state.budget, event.reservePercent), event.budget)
      : buildBudgetFor(event);
  } catch (err) {
    toast(`Budget could not be built: ${err.message}`, 'danger');
    return;
  }

  const tasks = isEdit && state.tasks.length > 0
    ? rescheduleTimeline(state.tasks, { newEventDate: event.date }).tasks
    : generateTimeline(event).tasks;

  update({ event, budget, tasks });
  document.getElementById('cancelEditBtn').hidden = true;
  setView('overview');

  if (!isEdit) {
    toast(`Event created. ${tasks.length} timeline tasks generated.`, 'ok');
    await generatePlan();
  } else {
    toast('Event updated. Budget and deadlines recalculated.', 'ok');
  }
}

/* ───────────────── Boot ───────────────── */

function boot() {
  const { state: loaded, status, message } = loadState();
  state = loaded;

  if (status === 'corrupt' || status === 'future-version' || status === 'unavailable') {
    toast(message, 'danger', { timeout: 11000 });
  } else if (status === 'partial') {
    toast(message, 'warn', { timeout: 9000 });
  }

  for (const btn of document.querySelectorAll('.nav__item, .mobile-nav__item')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
  document.getElementById('eventForm').addEventListener('submit', onSubmitEvent);
  document.getElementById('editEventBtn').addEventListener('click', () => {
    fillForm(state.event);
    document.getElementById('cancelEditBtn').hidden = false;
    setView('create');
  });
  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    document.getElementById('cancelEditBtn').hidden = true;
    setView('overview');
  });
  document.getElementById('regenBtn').addEventListener('click', generatePlan);
  document.getElementById('planGenerateBtn').addEventListener('click', generatePlan);
  document.getElementById('addVendorBtn').addEventListener('click', () => openVendorDialog());

  if (state.event && state.budget) {
    setView(VIEWS.includes(state.preferences?.lastView) ? state.preferences.lastView : 'overview');
  } else {
    setView('create');
  }
}

window.addEventListener('error', (e) => {
  toast(`Something broke: ${e.message}. Your saved data is untouched.`, 'danger', { timeout: 10000 });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Exposed for manual verification in the browser console and for the smoke test.
window.CelebrAI = {
  getState: () => state,
  derive,
  setView,
};
