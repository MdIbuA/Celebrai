/**
 * validation.js — all input and untrusted-data validation.
 *
 * Three distinct trust boundaries are handled here:
 *   1. User form input            -> validateEvent()
 *   2. Model-generated JSON       -> validatePlanResponse()
 *   3. Imported files from disk   -> validateImportedState()
 *
 * Every function returns { ok, errors, value } rather than throwing, so the UI
 * can render all problems at once instead of one at a time.
 */

import { MAX_RUPEES } from './money.js';

export const EVENT_CATEGORIES = [
  { id: 'wedding', label: 'Wedding' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'engagement', label: 'Engagement' },
  { id: 'college', label: 'College Event' },
  { id: 'community', label: 'Community Gathering' },
];

export const MAX_GUESTS = 100000;
export const MAX_TEXT = 2000;
export const MAX_SHORT_TEXT = 160;

const EVENT_CATEGORY_IDS = new Set(EVENT_CATEGORIES.map((c) => c.id));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Collapse whitespace and clamp length. Never used as a security control. */
export function normaliseText(value, maxLength = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Parse a YYYY-MM-DD string into a UTC-midnight Date, or null. */
export function parseISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null; // rejects 2026-02-30 and friends
  }
  return date;
}

export function toISODate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, positive when `to` is later. */
export function daysBetween(from, to) {
  const MS = 86400000;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS);
}

/**
 * Validate the event-creation form.
 * @param {object} raw  Raw field values (usually strings from the DOM).
 * @param {{today?: Date}} opts
 */
export function validateEvent(raw, opts = {}) {
  const errors = {};
  const today = opts.today ? new Date(opts.today) : new Date();
  const input = raw && typeof raw === 'object' ? raw : {};

  const name = normaliseText(input.name, MAX_SHORT_TEXT);
  if (!name) errors.name = 'Give the event a name so you can recognise it later.';
  else if (name.length < 3) errors.name = 'Event name must be at least 3 characters.';

  const category = normaliseText(input.category, 40);
  if (!category) errors.category = 'Choose an event category.';
  else if (!EVENT_CATEGORY_IDS.has(category)) errors.category = 'Unsupported event category.';

  const dateValue = normaliseText(input.date, 10);
  const date = parseISODate(dateValue);
  if (!dateValue) errors.date = 'Pick the event date.';
  else if (!date) errors.date = 'Use a real calendar date in YYYY-MM-DD format.';

  const location = normaliseText(input.location, MAX_SHORT_TEXT);
  if (!location) errors.location = 'Enter the city or venue area.';

  const guestsRaw = input.guestCount;
  const guestCount = Number(
    typeof guestsRaw === 'string' ? guestsRaw.trim() : guestsRaw,
  );
  if (guestsRaw === '' || guestsRaw === null || guestsRaw === undefined) {
    errors.guestCount = 'Enter an expected guest count.';
  } else if (!Number.isFinite(guestCount) || !Number.isInteger(guestCount)) {
    errors.guestCount = 'Guest count must be a whole number.';
  } else if (guestCount < 0) {
    errors.guestCount = 'Guest count cannot be negative.';
  } else if (guestCount > MAX_GUESTS) {
    errors.guestCount = `Guest count above ${MAX_GUESTS.toLocaleString('en-IN')} is not supported.`;
  }

  const budgetRaw = input.budget;
  const budget = Number(typeof budgetRaw === 'string' ? budgetRaw.trim() : budgetRaw);
  if (budgetRaw === '' || budgetRaw === null || budgetRaw === undefined) {
    errors.budget = 'Enter the total budget in INR.';
  } else if (!Number.isFinite(budget)) {
    errors.budget = 'Budget must be a number.';
  } else if (budget <= 0) {
    errors.budget = 'Budget must be greater than zero.';
  } else if (budget > MAX_RUPEES) {
    errors.budget = 'Budget is outside the supported range.';
  }

  const reserveRaw = input.reservePercent;
  let reservePercent = reserveRaw === '' || reserveRaw === undefined || reserveRaw === null
    ? 10
    : Number(reserveRaw);
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 50) {
    errors.reservePercent = 'Emergency reserve must be between 0% and 50%.';
    reservePercent = 10;
  }

  const value = {
    name,
    category,
    date: dateValue,
    location,
    guestCount: Number.isFinite(guestCount) ? guestCount : 0,
    budget: Number.isFinite(budget) ? budget : 0,
    reservePercent,
    theme: normaliseText(input.theme, MAX_SHORT_TEXT),
    cultural: normaliseText(input.cultural, MAX_TEXT),
    dietary: normaliseText(input.dietary, MAX_TEXT),
    accessibility: normaliseText(input.accessibility, MAX_TEXT),
    nonNegotiables: normaliseText(input.nonNegotiables, MAX_TEXT),
    optionalPreferences: normaliseText(input.optionalPreferences, MAX_TEXT),
  };

  const warnings = [];
  if (date) {
    const delta = daysBetween(today, date);
    if (delta < 0) {
      warnings.push({
        code: 'past-date',
        message: `This date is ${Math.abs(delta)} day(s) in the past. Timeline tasks will be marked overdue.`,
      });
    } else if (delta <= 14) {
      warnings.push({
        code: 'short-notice',
        message: `Only ${delta} day(s) until the event. Short-notice planning mode will compress the timeline.`,
      });
    }
    if (value.guestCount === 0) {
      warnings.push({
        code: 'zero-guests',
        message: 'Guest count is zero. Per-guest costs will show as not applicable.',
      });
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, warnings, value };
}

/* ------------------------------------------------------------------ *
 * AI response schema
 * ------------------------------------------------------------------ */

const STRING_ARRAY_SECTIONS = [
  'assumptions',
  'themeRecommendations',
  'foodSuggestions',
  'activitySuggestions',
  'costSavingAlternatives',
  'outstandingQuestions',
];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanStringArray(value, { max = 12, maxLength = 400 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string')
    .map((v) => normaliseText(v, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Validate a model-produced plan.
 *
 * Deliberately strict and lossy: anything unrecognised is dropped rather than
 * passed through. Monetary values are NOT accepted from the model — only
 * category *weights*, which budget-engine.js turns into rupees. This is the
 * single most important security/correctness boundary in the app.
 *
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validatePlanResponse(raw) {
  const errors = [];
  let parsed = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: [`Response was not valid JSON: ${err.message}`], value: null };
    }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['Response must be a JSON object.'], value: null };
  }

  const summary = normaliseText(parsed.summary, 1200);
  if (!summary) errors.push('Missing "summary".');

  // Budget weights: { categoryId: number }
  const weights = [];
  if (!isPlainObject(parsed.budgetWeights)) {
    errors.push('Missing "budgetWeights" object.');
  } else {
    for (const [key, weight] of Object.entries(parsed.budgetWeights)) {
      const id = normaliseText(key, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const n = Number(weight);
      if (!id) continue;
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        errors.push(`Invalid weight for category "${key}".`);
        continue;
      }
      weights.push({ key: id, weight: n, label: normaliseText(key, 40) });
    }
    if (weights.length === 0) errors.push('"budgetWeights" contained no usable categories.');
  }

  // Tasks: title + daysBefore offset. No absolute dates trusted from the model.
  const tasks = [];
  if (Array.isArray(parsed.tasks)) {
    for (const t of parsed.tasks.slice(0, 40)) {
      if (!isPlainObject(t)) continue;
      const title = normaliseText(t.title, 120);
      const daysBefore = Number(t.daysBefore);
      if (!title) continue;
      if (!Number.isFinite(daysBefore) || daysBefore < 0 || daysBefore > 1095) continue;
      tasks.push({
        title,
        description: normaliseText(t.description, 400),
        daysBefore: Math.round(daysBefore),
        priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
        budgetCategory: normaliseText(t.budgetCategory, 40) || null,
      });
    }
  }

  const vendors = [];
  if (Array.isArray(parsed.vendorChecklist)) {
    for (const v of parsed.vendorChecklist.slice(0, 20)) {
      if (!isPlainObject(v)) continue;
      const category = normaliseText(v.category, 40);
      if (!category) continue;
      vendors.push({
        category,
        whatToAskFor: normaliseText(v.whatToAskFor, 400),
        typicalLeadTimeDays: Number.isFinite(Number(v.typicalLeadTimeDays))
          ? Math.max(0, Math.round(Number(v.typicalLeadTimeDays)))
          : null,
      });
    }
  }

  const risks = [];
  if (Array.isArray(parsed.risks)) {
    for (const r of parsed.risks.slice(0, 12)) {
      if (typeof r === 'string') {
        const text = normaliseText(r, 400);
        if (text) risks.push({ risk: text, mitigation: '', severity: 'medium' });
        continue;
      }
      if (!isPlainObject(r)) continue;
      const risk = normaliseText(r.risk, 400);
      if (!risk) continue;
      risks.push({
        risk,
        mitigation: normaliseText(r.mitigation, 400),
        severity: ['high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium',
      });
    }
  }

  const value = {
    summary,
    tasks,
    vendorChecklist: vendors,
    risks,
    budgetWeights: weights,
  };
  for (const section of STRING_ARRAY_SECTIONS) {
    value[section] = cleanStringArray(parsed[section]);
  }

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

/* ------------------------------------------------------------------ *
 * Import validation
 * ------------------------------------------------------------------ */

const FORBIDDEN_IMPORT_KEYS = ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization'];

/**
 * Validate a user-supplied exported state file before it replaces live data.
 * Rejects wrong shapes and strips anything credential-shaped.
 */
export function validateImportedState(raw) {
  const errors = [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: [`File is not valid JSON: ${err.message}`], value: null };
    }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['Import must be a JSON object.'], value: null };
  }
  if (parsed.app !== 'CelebrAI') {
    errors.push('This file was not exported by CelebrAI.');
  }
  if (!isPlainObject(parsed.event)) {
    errors.push('Import is missing the "event" object.');
  }
  if (parsed.schemaVersion !== undefined && Number(parsed.schemaVersion) > 1) {
    errors.push(`Unsupported schema version ${parsed.schemaVersion}. Update CelebrAI first.`);
  }

  if (errors.length > 0) return { ok: false, errors, value: null };

  const eventCheck = validateEvent(parsed.event, { today: new Date() });
  // A past date is a warning, not an import failure — old events are importable.
  const fatal = Object.entries(eventCheck.errors).filter(([k]) => k !== 'date' || !parsed.event.date);
  if (fatal.length > 0) {
    return {
      ok: false,
      errors: fatal.map(([field, msg]) => `event.${field}: ${msg}`),
      value: null,
    };
  }

  const stripSecrets = (obj) => {
    if (Array.isArray(obj)) return obj.map(stripSecrets);
    if (!isPlainObject(obj)) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_IMPORT_KEYS.some((bad) => k.toLowerCase().includes(bad.toLowerCase()))) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  };

  return {
    ok: true,
    errors: [],
    value: stripSecrets({
      event: { ...eventCheck.value, id: normaliseText(parsed.event.id, 60) || undefined },
      budget: isPlainObject(parsed.budget) ? parsed.budget : null,
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      vendors: Array.isArray(parsed.vendors) ? parsed.vendors : [],
      plan: isPlainObject(parsed.plan) ? parsed.plan : null,
    }),
  };
}
