/**
 * Headless smoke test of the real application.
 *
 * This file is NOT part of `npm test` and ships no dependency: it needs jsdom,
 * which CelebrAI deliberately does not depend on. Run it with jsdom available
 * on NODE_PATH when you want to verify the primary user journey without
 * opening a browser:
 *
 *   npm i -g jsdom   (or: npm i jsdom in a scratch folder)
 *   NODE_PATH=<that folder>/node_modules node tests/smoke-dom.js
 *
 * It boots index.html + js/app.js against a DOM, then drives the journey:
 * create event -> plan generated -> budget reconciles -> guest change ->
 * date change -> task status -> vendor booking -> export.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('\n  SKIPPED: jsdom is not installed. See the header of this file.\n');
  process.exit(0);
}

const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
// Inline the real stylesheet so computed-style checks exercise the actual CSS.
const css = readFileSync(join(here, '..', 'css', 'styles.css'), 'utf8');
const dom = new JSDOM(
  html.replace('<link rel="stylesheet" href="css/styles.css" />', `<style>${css}</style>`),
  { url: 'https://celebrai.test/', pretendToBeVisual: true },
);

// Expose the DOM to the modules, which expect browser globals.
const { window } = dom;
for (const key of ['HTMLElement', 'Element', 'Node', 'Blob', 'FileReader', 'CustomEvent', 'Event', 'getComputedStyle']) {
  try { globalThis[key] = window[key]; } catch { /* read-only global in this Node version */ }
}
globalThis.window = window;
globalThis.document = window.document;
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function noop() {};
window.scrollTo = () => {}; // jsdom does not implement it; irrelevant here

// jsdom supplies a real localStorage when a url is set; share it with the modules.
globalThis.localStorage = window.localStorage;
const mem = {
  get: (k) => window.localStorage.getItem(k),
};

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('\n\x1b[1mheadless smoke test — primary user journey\x1b[0m');

await import('../js/app.js');
await tick();

const api = window.CelebrAI ?? globalThis.CelebrAI;
check('application boots without throwing', Boolean(api));
check('creation view is shown when there is no saved event',
  !document.getElementById('view-create').hidden);
check('demo mode is advertised up front',
  document.getElementById('modeBadgeText').textContent.toLowerCase().includes('demo'));

// Regression guard for a real bug: `.modal { display: grid }` overrides the
// UA rule behind the `hidden` attribute, so the dialog and its page-dimming
// backdrop rendered permanently over the app.
//
// This is a SOURCE check, not a behavioural one. jsdom's cascade does not
// reproduce the bug — it reports display:none either way — so a computed-style
// assertion would pass against the broken stylesheet and prove nothing.
check('stylesheet neutralises `display` rules on hidden elements',
  /\[hidden\]\s*{[^}]*display:\s*none\s*!important/.test(css),
  'css/styles.css needs a global [hidden] { display: none !important } rule');
check('the modal element is marked hidden in the markup',
  document.getElementById('modal').hasAttribute('hidden'));

/* --- invalid submission is rejected --- */
const form = document.getElementById('eventForm');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await tick();
check('empty form is rejected with field errors',
  document.getElementById('e-name').textContent.length > 0 && api.getState().event === null);

/* --- valid submission --- */
const set = (sel, v) => { document.querySelector(sel).value = v; };
set('#f-name', 'Ayesha & Imran Nikah');
set('#f-category', 'wedding');
set('#f-date', '2027-02-14');
set('#f-location', 'Coimbatore');
set('#f-guests', '250');
set('#f-budget', '800000');
set('#f-reserve', '10');
set('#f-theme', 'Temple traditional');
set('#f-dietary', 'Halal only, one Jain counter');
set('#f-accessibility', 'Wheelchair ramp at the entrance');
set('#f-nonneg', 'Nikah must be before 11am');

form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 12; i += 1) await tick();

let s = api.getState();
check('event is created', s.event?.name === 'Ayesha & Imran Nikah');
check('timeline tasks are generated', s.tasks.length > 8, `got ${s.tasks?.length}`);
check('a plan is generated automatically', Boolean(s.plan));
check('plan is labelled as demo output', s.plan?.source === 'demo');
check('plan notice does not claim live AI', !/\bgenerated by a language model\b/i.test(s.plan?.notice ?? ''));

let d = api.derive();
check('budget reconciles exactly', d.summary.reconciles);
check('allocations + reserve = total',
  d.summary.allocatedPaise + d.summary.reservePaise + d.summary.unallocatedPaise === d.summary.totalBudgetPaise);
check('total budget is exactly what the user entered',
  d.summary.totalBudgetPaise === 80000000, `got ${d.summary.totalBudgetPaise}`);
check('per-guest cost is computed', d.summary.perGuestAllocatedPaise > 0);

/* --- rendering --- */
api.setView('overview');
await tick();
const ovText = document.getElementById('ovBody').textContent;
check('overview renders budget figures', ovText.includes('₹'));
check('overview shows the vendor-verification caveat somewhere in the app',
  document.body.textContent.toLowerCase().includes('not verif') ||
  document.body.textContent.toLowerCase().includes('does not verify'));

api.setView('plan');
await tick();
const planText = document.getElementById('planBody').textContent;
check('plan view renders the demo banner', planText.includes('DEMO OUTPUT'));
check('plan view renders risks and cost savings',
  planText.includes('Risks') && planText.includes('Cost-saving alternatives'));

api.setView('budget');
await tick();
check('budget view renders replanning controls',
  document.getElementById('budgetBody').textContent.includes('Replanning controls'));

api.setView('timeline');
await tick();
check('timeline view renders tasks',
  document.getElementById('timelineBody').textContent.includes('Due '));

/* --- XSS: untrusted text must never become markup --- */
const xssForm = () => {
  set('#f-name', '<img src=x onerror="window.__pwned=1">');
  document.getElementById('editEventBtn').click();
  set('#f-name', '<img src=x onerror="window.__pwned=1">');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
};
xssForm();
for (let i = 0; i < 8; i += 1) await tick();
check('untrusted event name is not injected as HTML',
  !window.__pwned && document.getElementById('ovTitle').querySelector('img') === null);
check('untrusted text is preserved as literal text',
  document.getElementById('ovTitle').textContent.includes('<img'));

// restore a sane name
document.getElementById('editEventBtn').click();
set('#f-name', 'Ayesha & Imran Nikah');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 8; i += 1) await tick();

/* --- task status change --- */
api.setView('timeline');
await tick();
const firstSelect = document.querySelector('#timelineBody .task select');
firstSelect.value = 'completed';
firstSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
s = api.getState();
check('task status persists', s.tasks.some((t) => t.status === 'completed'));
check('progress reflects the completed task', api.derive().progress.completed >= 1);

/* --- adaptive replanning: guest count --- */
api.setView('budget');
await tick();
const budgetBefore = api.derive().summary.totalBudgetPaise;
const perGuestBefore = api.derive().summary.perGuestAllocatedPaise;
const guestField = [...document.querySelectorAll('#budgetBody .field')]
  .find((f) => f.querySelector('label')?.textContent.includes('Guest count'));
guestField.querySelector('input').value = '400';
guestField.querySelector('button').click();
await tick();
const modalText = document.getElementById('modalBody').textContent;
check('guest-count change opens a trade-off dialog', !document.getElementById('modal').hidden);
check('dialog quantifies the shortfall instead of silently rescaling',
  modalText.includes('Shortfall') || modalText.includes('fits inside'));
check('dialog restates the non-negotiables', modalText.includes('Nikah must be before 11am'));
[...document.querySelectorAll('#modalActions button')].find((b) => b.textContent.includes('Apply')).click();
for (let i = 0; i < 4; i += 1) await tick();
d = api.derive();
check('guest count is updated', api.getState().event.guestCount === 400);
check('budget ceiling is preserved through replanning (never silently raised)',
  d.summary.totalBudgetPaise === budgetBefore, `was ${budgetBefore}, now ${d.summary.totalBudgetPaise}`);
check('per-guest cost falls when guests rise at a fixed ceiling',
  d.summary.perGuestAllocatedPaise < perGuestBefore);

/* --- adaptive replanning: date --- */
api.setView('budget');
await tick();
const deadlinesBefore = api.getState().tasks.map((t) => t.deadline).join(',');
const dateField = [...document.querySelectorAll('#budgetBody .field')]
  .find((f) => f.querySelector('label')?.textContent.includes('Event date'));
dateField.querySelector('input').value = '2027-04-14';
dateField.querySelector('button').click();
for (let i = 0; i < 4; i += 1) await tick();
check('event date is updated', api.getState().event.date === '2027-04-14');
check('every deadline is recalculated',
  api.getState().tasks.map((t) => t.deadline).join(',') !== deadlinesBefore);
check('no deadline lands after the new event date',
  api.getState().tasks.every((t) => t.deadline <= '2027-04-14'));

/* --- vendor booking feeds the budget --- */
api.setView('vendors');
await tick();
document.getElementById('addVendorBtn').click();
await tick();
document.getElementById('vName').value = 'Shortlisted banquet hall';
document.getElementById('vCat').value = 'venue';
document.getElementById('vCost').value = '175000';
[...document.querySelectorAll('#modalActions button')].find((b) => b.textContent === 'Add').click();
for (let i = 0; i < 3; i += 1) await tick();
check('vendor record is created', api.getState().vendors.length === 1);
check('new vendor is stamped unverified',
  api.getState().vendors[0].verification === 'unverified-suggestion');
const venueEstimate = api.derive().summary.categories.find((c) => c.id === 'venue').estimatedPaise;
check('quoted cost lands in the budget as an estimate', venueEstimate === 17500000, `got ${venueEstimate}`);
const bookingSelect = [...document.querySelectorAll('#vendorsBody select')]
  .find((sel) => [...sel.options].some((o) => o.value === 'booked'));
bookingSelect.value = 'booked';
bookingSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
for (let i = 0; i < 3; i += 1) await tick();
const venueCat = api.derive().summary.categories.find((c) => c.id === 'venue');
check('booking it converts the estimate into actual spend',
  venueCat.actualPaise === 17500000 && venueCat.estimatedPaise === 0);
check('budget still reconciles after every replan', api.derive().summary.reconciles);

/* --- persistence --- */
check('state is written to localStorage', Boolean(mem.get('celebrai.state.v1')));
const saved = JSON.parse(mem.get('celebrai.state.v1'));
check('saved payload carries the schema version', saved.schemaVersion === 1);
check('saved payload keeps the user budget', saved.budget.totalBudgetPaise === 80000000);

/* --- export --- */
api.setView('settings');
await tick();
let exported = null;
const realBlob = window.Blob;
globalThis.Blob = class extends realBlob {
  constructor(parts, opts) { super(parts, opts); exported = String(parts[0]); }
};
[...document.querySelectorAll('#settingsBody button')]
  .find((b) => b.textContent.includes('Export'))?.click();
await tick();
globalThis.Blob = realBlob;
check('export produces JSON', Boolean(exported) && exported.trim().startsWith('{'));
const payload = exported ? JSON.parse(exported) : {};
check('export is marked as a CelebrAI file', payload.app === 'CelebrAI');
check('export carries the estimate disclaimer', String(payload.disclaimer).includes('not confirmed vendor quotations'));
check('export contains no key-shaped field', !/api[_-]?key|authorization|secret/i.test(exported ?? ''));

console.log(`\n${'-'.repeat(52)}`);
console.log(failures === 0 ? '  smoke test passed' : `  ${failures} smoke check(s) failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(failures === 0 ? 0 : 1);
