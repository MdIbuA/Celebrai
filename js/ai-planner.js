/**
 * ai-planner.js — the ONLY module that talks to a model.
 *
 * Design contract
 * ---------------
 * 1. The model never sees more than the planning context it needs. No names of
 *    guests, no contact details, no stored vendor notes.
 * 2. The model never returns rupee amounts that reach the user. It returns
 *    *weights*; budget-engine.js converts those to money. A hallucinated
 *    "₹4,50,000 for catering" cannot appear on the dashboard because there is
 *    no code path that accepts it.
 * 3. Every response passes validatePlanResponse() before use. Anything else is
 *    discarded and the user is told.
 * 4. The browser holds no API key. Calls go to a server-side proxy
 *    (server/proxy.js). If no proxy is configured, demo mode runs instead and
 *    is labelled as demo in the returned object itself.
 */

import { validatePlanResponse } from './validation.js';
import { templateFor } from './budget-engine.js';

/** Where the backend proxy lives. Configurable at runtime, never a secret. */
export const DEFAULT_PROXY_PATH = '/api/plan';
const CONFIG_KEY = 'celebrai.proxy';

export function getProxyEndpoint() {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(CONFIG_KEY);
      if (stored) return stored;
    }
  } catch { /* storage unavailable; fall through */ }
  if (typeof window !== 'undefined' && window.CELEBRAI_PROXY_ENDPOINT) {
    return String(window.CELEBRAI_PROXY_ENDPOINT);
  }
  return null;
}

export function setProxyEndpoint(url) {
  try {
    if (!url) localStorage.removeItem(CONFIG_KEY);
    else localStorage.setItem(CONFIG_KEY, String(url));
    return true;
  } catch {
    return false;
  }
}

export function isLiveModeConfigured() {
  return Boolean(getProxyEndpoint());
}

/**
 * Build the minimal planning context sent to the model.
 * Deliberately excludes: event name (can contain family names), vendor
 * contacts, notes, and anything else not needed for planning.
 */
export function buildPlanningContext(event, { budgetSummary } = {}) {
  return {
    eventCategory: event.category,
    eventDateISO: event.date,
    city: event.location,
    guestCount: event.guestCount,
    // Budget sent as a *band*, not an exact figure — the model only needs scale.
    budgetBand: budgetBandFor(event.budget),
    theme: event.theme || null,
    culturalPreferences: event.cultural || null,
    dietaryRequirements: event.dietary || null,
    accessibilityRequirements: event.accessibility || null,
    nonNegotiables: event.nonNegotiables || null,
    optionalPreferences: event.optionalPreferences || null,
    availableCategoryIds: templateFor(event.category).map((c) => c.id),
    committedCategories: budgetSummary
      ? budgetSummary.categories.filter((c) => c.committedPaise > 0).map((c) => c.id)
      : [],
  };
}

export function budgetBandFor(rupees) {
  const n = Number(rupees) || 0;
  if (n < 50000) return 'under-50k';
  if (n < 200000) return '50k-2L';
  if (n < 500000) return '2L-5L';
  if (n < 1500000) return '5L-15L';
  if (n < 5000000) return '15L-50L';
  return 'above-50L';
}

export const RESPONSE_SCHEMA_DESCRIPTION = `Return ONLY a JSON object with these keys:
  summary: string
  assumptions: string[]
  budgetWeights: { "<categoryId>": number }   // relative weights, 0-100, from availableCategoryIds only
  tasks: [{ title, description, daysBefore, priority: "high"|"medium"|"low", budgetCategory }]
  vendorChecklist: [{ category, whatToAskFor, typicalLeadTimeDays }]
  themeRecommendations: string[]
  foodSuggestions: string[]
  activitySuggestions: string[]
  risks: [{ risk, mitigation, severity: "high"|"medium"|"low" }]
  costSavingAlternatives: string[]
  outstandingQuestions: string[]
Never include currency amounts, vendor names, phone numbers, or claims about availability.`;

export class PlanError extends Error {
  constructor(message, { kind = 'unknown', details = [] } = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Request a plan.
 *
 * @returns {Promise<{source:'live'|'demo', plan:object, notice:string}>}
 * Throws PlanError only when live mode was configured and failed; callers
 * decide whether to fall back to demo (and the fallback is always labelled).
 */
export async function requestPlan(event, opts = {}) {
  const endpoint = opts.endpoint ?? getProxyEndpoint();
  const context = buildPlanningContext(event, opts);

  if (!endpoint) {
    return {
      source: 'demo',
      plan: buildDemoPlan(event, context),
      notice: 'Demo mode: this plan was produced by CelebrAI’s built-in rule engine, not by a language model. No AI provider is configured.',
    };
  }

  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new PlanError('No fetch implementation available.', { kind: 'environment' });

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), opts.timeoutMs ?? 30000);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, schema: RESPONSE_SCHEMA_DESCRIPTION }),
      signal: controller?.signal,
    });
  } catch (err) {
    throw new PlanError(
      err.name === 'AbortError'
        ? 'The planning service did not respond in time.'
        : `Could not reach the planning service: ${err.message}`,
      { kind: 'network' },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new PlanError(`Planning service returned HTTP ${response.status}.`, { kind: 'http' });
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new PlanError('Planning service returned a non-JSON response.', { kind: 'parse' });
  }

  const check = validatePlanResponse(body.plan ?? body);
  if (!check.ok) {
    throw new PlanError('The model returned a plan that failed schema validation.', {
      kind: 'schema',
      details: check.errors,
    });
  }

  return {
    source: 'live',
    plan: check.value,
    notice: 'Generated by a language model through the configured server-side proxy. Costs below are computed locally by CelebrAI, not by the model.',
  };
}

/* ------------------------------------------------------------------ *
 * Demo mode — deterministic, clearly labelled, genuinely useful
 * ------------------------------------------------------------------ */

const DEMO_THEMES = {
  wedding: ['Traditional temple palette: marigold, deep red, brass accents', 'Minimal pastel mandap with layered drapes and warm uplighting', 'Garden evening setting with fairy lights and low seating pockets'],
  birthday: ['Single-colour balloon arch with a contrasting cake table', 'Theme corner for photos instead of decorating the whole hall', 'Reusable fabric backdrop over disposable printed banners'],
  engagement: ['Ring-exchange stage with focused lighting, simple surroundings', 'Floral backdrop in two tones matching the attire', 'Candle-and-glass table centres for an evening function'],
  college: ['Stage branding with sponsor banners at eye level', 'LED wall or projector for speaker sessions and sponsor loops', 'Photo wall near entry to drive social media reach'],
  community: ['Shamiana seating with clear aisles for elderly guests', 'Shared community decor pool to cut costs', 'Simple stage with strong audio rather than heavy decor'],
};

const DEMO_FOOD = {
  wedding: ['Fixed multi-course menu rather than open live counters', 'Two live counters maximum; they drive cost fastest', 'Separate clearly-labelled vegetarian/Jain counter'],
  birthday: ['Snack-plus-cake format instead of full meal for short events', 'One hot item, one cold item, one sweet', 'Pre-portioned servings to reduce wastage'],
  engagement: ['High tea format for afternoon events', 'Welcome drink plus 6-8 starters, limited main course', 'Dessert counter instead of plated dessert'],
  college: ['Boxed refreshments for predictable per-head cost', 'Water stations instead of bottled water per guest', 'Tie-up with a single canteen vendor for volume pricing'],
  community: ['Buffet with volunteer-managed serving lines', 'Community kitchen model where feasible', 'Single standard menu with one dietary alternative'],
};

const DEMO_ACTIVITIES = {
  wedding: ['Pre-event mehendi/sangeet slot', 'Photo booth with props during cocktail hour', 'Short family video montage before dinner'],
  birthday: ['Age-appropriate games block of 45 minutes', 'Cake cutting scheduled at the midpoint, not the end', 'Group photo slot before guests start leaving'],
  engagement: ['Ring ceremony as the anchor, kept under 30 minutes', 'Short speech slot for both families', 'Music set during dinner'],
  college: ['Keynote, panel, then hands-on session', 'Networking break with a structured prompt', 'Certificate distribution as the closing hook'],
  community: ['Opening address kept under 10 minutes', 'Cultural performances in 15-minute slots', 'Prize/recognition segment near the end to retain attendance'],
};

/**
 * The demo planner is a real rule engine, not canned text: weights come from
 * the category template, task offsets from the timeline engine's own logic,
 * and risks are selected from the actual event parameters.
 */
export function buildDemoPlan(event, context = buildPlanningContext(event)) {
  const category = event.category;
  const template = templateFor(category);
  const guests = Number(event.guestCount) || 0;

  const budgetWeights = template.map((c) => ({ key: c.id, weight: c.weight, label: c.label }));

  // Nudge weights on real signals rather than returning a static template.
  const dietary = (event.dietary || '').toLowerCase();
  if (dietary.includes('jain') || dietary.includes('vegan') || dietary.includes('allerg')) {
    const catering = budgetWeights.find((w) => w.key === 'catering');
    if (catering) catering.weight += 3;
  }
  if (guests > 300) {
    const venue = budgetWeights.find((w) => w.key === 'venue');
    if (venue) venue.weight += 2;
  }

  const risks = [];
  if (context.budgetBand === 'under-50k' && guests > 100) {
    risks.push({
      risk: `A budget in the ${context.budgetBand} band for ${guests} guests leaves very little per head.`,
      mitigation: 'Either cut the guest list or move to a snack-format menu. Do not assume catering quotes will absorb the gap.',
      severity: 'high',
    });
  }
  if ((event.accessibility || '').trim()) {
    risks.push({
      risk: 'Accessibility requirements are stated but venue suitability is unverified.',
      mitigation: 'Physically check ramp access, washroom access and seating sightlines before paying any venue advance.',
      severity: 'high',
    });
  }
  risks.push(
    {
      risk: 'Vendor advances paid without a written scope of work.',
      mitigation: 'Get deliverables, timings and cancellation terms in writing before any transfer.',
      severity: 'high',
    },
    {
      risk: 'Guest count drifts upward after invitations go out.',
      mitigation: 'Close RSVPs two weeks ahead and confirm the caterer’s overflow rate in advance.',
      severity: 'medium',
    },
    {
      risk: 'Weather or venue disruption on the day.',
      mitigation: 'Confirm an indoor fallback and ask the venue for its power-backup arrangement in writing.',
      severity: 'medium',
    },
  );

  const assumptions = [
    'Costs are planning estimates derived from your stated budget, not vendor quotations.',
    `Budget split uses CelebrAI’s ${category} template as a starting point; every category is editable.`,
    `Guest count of ${guests} is treated as final for per-guest figures.`,
    'No vendor availability has been checked. CelebrAI has no live vendor data.',
  ];
  if (event.nonNegotiables) {
    assumptions.push(`Your non-negotiables are preserved as stated and are never auto-adjusted: ${event.nonNegotiables}`);
  }

  const vendorChecklist = template.map((c) => ({
    category: c.label,
    whatToAskFor: vendorAskFor(c.id),
    typicalLeadTimeDays: vendorLeadTime(c.id),
  }));

  const costSaving = [
    'Move the event to a weekday or off-season date; venue rates typically drop.',
    'Reduce the number of live counters before reducing menu quality.',
    'Reuse decor across functions instead of commissioning separate setups.',
    'Negotiate photography deliverables (edited photo count, album) rather than the day rate.',
    'Ask vendors for an itemised quote so you can remove line items instead of haggling on the total.',
  ];
  if (guests > 150) costSaving.push('A 10% guest-list cut usually saves more than every decor negotiation combined.');

  const outstandingQuestions = [
    'Is the budget a hard ceiling, or is there a contingency above it?',
    'Who has final sign-off on vendor bookings?',
    'Are there fixed ritual timings that constrain the run-sheet?',
    'How many guests are travelling in and need accommodation or transport?',
  ];
  if (!event.theme) outstandingQuestions.push('No theme was specified — is that a decision still open, or deliberately plain?');

  return {
    summary: `${describeCategory(category)} for about ${guests} guest(s) in ${event.location || 'your city'} on ${event.date}. The plan below splits your budget across ${template.length} categories, generates a working timeline from the event date backwards, and lists what to confirm with each vendor type. All figures are CelebrAI calculations, not quotations.`,
    assumptions,
    budgetWeights,
    tasks: [],
    vendorChecklist,
    themeRecommendations: DEMO_THEMES[category] ?? DEMO_THEMES.community,
    foodSuggestions: DEMO_FOOD[category] ?? DEMO_FOOD.community,
    activitySuggestions: DEMO_ACTIVITIES[category] ?? DEMO_ACTIVITIES.community,
    risks,
    costSavingAlternatives: costSaving,
    outstandingQuestions,
  };
}

function describeCategory(id) {
  return {
    wedding: 'Wedding',
    birthday: 'Birthday celebration',
    engagement: 'Engagement function',
    college: 'College event',
    community: 'Community gathering',
  }[id] ?? 'Celebration';
}

function vendorAskFor(id) {
  return {
    venue: 'Written rental window, overtime charges, power backup, parking capacity, and what the venue supplies versus what you must bring.',
    catering: 'Per-plate rate at your final headcount, overflow rate, service staff count, and dietary-variant handling.',
    decor: 'Itemised setup list, setup/teardown timings, and whether structures are rented or built.',
    photography: 'Hours of coverage, number of shooters, edited photo count, delivery timeline, and raw-file policy.',
    attire: 'Fitting schedule, alteration charges, and the last date for changes.',
    music: 'Equipment list, backup equipment, operator presence, and noise-permit responsibility.',
    entertainment: 'Performance duration, space and power needs, and cancellation terms.',
    invitations: 'Proofing rounds, print turnaround, and delivery or distribution responsibility.',
    transport: 'Vehicle count and capacity, waiting charges, and driver contact protocol on the day.',
    speakers: 'Session length, AV needs, travel and honorarium terms, and confirmation deadline.',
    marketing: 'Design turnaround, print quantity pricing, and installation responsibility.',
    volunteers: 'Shift schedule, briefing time, and refreshment arrangements.',
  }[id] ?? 'Scope of work, exact cost inclusions, timings, and cancellation terms in writing.';
}

function vendorLeadTime(id) {
  return {
    venue: 90, catering: 60, decor: 45, photography: 75, attire: 60,
    music: 30, entertainment: 35, invitations: 40, transport: 25,
    speakers: 45, marketing: 25, volunteers: 21,
  }[id] ?? 30;
}
