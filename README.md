# CelebrAI

**Big celebrations. Smart planning. Zero budget surprises.**

A GenAI-assisted planner for weddings, birthdays, engagements, college events and community gatherings. CelebrAI turns an event brief — date, city, guest count, budget, cultural and dietary requirements — into a budget allocation, a working timeline, a vendor checklist and an honest list of the things that are likely to go wrong.

It is a planning tool, not a chatbot. The conversation is the input; the output is a dashboard you work from.

**Live app: [mdibua.github.io/Celebrai](https://mdibua.github.io/Celebrai/)** — runs fully in demo mode, no setup, no sign-in.

- **Challenge:** Challenge 5 — Celebration & Event Planner
- **Vertical:** Consumer / social event planning, India-first (INR, Indian-locale formatting, Indian event categories)
- **Stack:** HTML5, CSS3, vanilla JavaScript ES modules. Zero runtime dependencies.

---

## 1. The problem

Event budgets fail in a specific, repeatable way:

1. A total is agreed. Nobody splits it per category until vendors are already quoting.
2. Guest count creeps up. Catering and venue scale with it; nothing else is renegotiated.
3. Each individual overrun looks small. Nobody holds the running total.
4. The gap surfaces two weeks out, when every decision is expensive to reverse.

Generic AI chat makes this worse, not better. Ask a language model for a wedding budget and it will produce confident rupee figures that are invented, arithmetic that does not add up, and vendor names that may not exist. A planning tool that does that is actively dangerous: the user acts on fake numbers.

CelebrAI is built around that failure. **The model never produces a number that reaches the user.**

## 2. Target users

| User | What they need |
|---|---|
| Families planning a wedding or engagement | A defensible category split and an early warning when guest count breaks the budget |
| Someone planning a birthday or house function | A short, realistic checklist rather than a 200-item generic template |
| College event / club organisers | Permissions, sponsors, AV and publicity as first-class tasks, with deadlines that work backwards from the event |
| Community and residents' associations | Permits, volunteers, safety and waste handled explicitly, with a shared cost picture |

## 3. Core features

**Event creation** — Validated form: name, category, date, city, guest count, INR budget, emergency reserve, theme, cultural preferences, dietary requirements, accessibility requirements, non-negotiables, optional preferences. Past dates, zero-guest events and short-notice events are *warnings*, not blocks — they are real situations.

**AI planning assistant** — Produces a structured plan: summary, assumptions, budget allocation, timeline, vendor checklist, theme and decoration recommendations, food and activity suggestions, risks, cost-saving alternatives, outstanding questions. Schema-validated. Money recomputed locally.

**Budget engine** — Configurable categories, allocated / estimated / actual tracking, remaining funds, emergency reserve, overrun detection, per-guest costs, missing-allocation detection. All arithmetic in integer paise.

**Adaptive replanning** — Change budget, guest count, date, preferences, vendor costs or bookings. CelebrAI recalculates, reports the trade-off, preserves your non-negotiables, and tells you when something does not fit instead of quietly making it fit.

**Timeline engine** — Tasks generated backwards from the event date with dependencies, priorities, four statuses, derived blocking, overdue detection and a compressed short-notice mode.

**Vendor management** — Eight configurable categories; shortlist, booking and payment status; quoted cost; contact notes. Every record carries a verification stamp.

**Persistence and export** — Versioned LocalStorage with corrupt-data recovery; JSON export and validated import; confirmed deletion.

## 4. Architecture

```
index.html          Semantic shell: sidebar, six views, modal, toast host
css/styles.css      Design tokens, light + dark themes, responsive layout, print styles
js/
  money.js          Integer-paise arithmetic, largest-remainder allocation, INR formatting
  validation.js     Form rules, AI response schema, import schema, date handling
  budget-engine.js  Allocation, expenses, reserve, overruns, per-guest, guest-change projection
  timeline-engine.js Task templates, scheduling, dependencies, status derivation
  vendor-manager.js Vendor records, status transitions, vendor-to-expense mapping
  storage.js        Versioned LocalStorage, defensive load, export payload builder
  ai-planner.js     Context builder, proxy call, schema gate, demo rule engine
  ui.js             Safe DOM construction, cards, tables, pills, toasts, modal
  app.js            State, routing, rendering, replanning handlers
server/proxy.js     Optional: static server + /api/plan key-holding proxy (zero deps)
tests/              Zero-dependency runner, 86 unit tests, 44-check headless smoke test
```

The dependency direction is strict: `app.js` → engines → `money.js`. No engine imports the UI; no UI module computes money.

### Module responsibilities

| Module | Owns | Never does |
|---|---|---|
| `money.js` | All arithmetic on currency | Know what a "budget category" is |
| `budget-engine.js` | Allocation, reconciliation, overrun rules | Touch the DOM or call a model |
| `timeline-engine.js` | Dates, dependencies, status derivation | Store anything |
| `ai-planner.js` | Prompting, transport, schema gate, demo fallback | Produce a rupee figure |
| `validation.js` | Every trust boundary | Mutate state |
| `ui.js` | DOM construction | Hold state or business rules |
| `app.js` | State transitions and orchestration | Compute money or dates itself |

## 5. AI approach and context handling

### What gets sent

`buildPlanningContext()` sends a deliberately reduced payload:

```js
{ eventCategory, eventDateISO, city, guestCount,
  budgetBand: "5L-15L",        // a band, never the exact figure
  theme, culturalPreferences, dietaryRequirements,
  accessibilityRequirements, nonNegotiables, optionalPreferences,
  availableCategoryIds, committedCategories }
```

Not sent: the event name (families' names live there), vendor names, contacts, notes, expense history, or anything else not needed to plan.

### What comes back

The model returns weights and prose. Specifically it returns `budgetWeights: { venue: 25, catering: 30, ... }` — relative numbers in the range 0–100. It does **not** return rupees, and `validatePlanResponse()` drops every unrecognised key, so a hallucinated `budgetAllocation: { catering: 450000 }` is discarded before it can reach a render function. There is no code path from model output to a currency value on screen. Task timing comes back as `daysBefore` offsets, never as absolute dates, so the timeline engine remains the only thing that computes a deadline.

### Trust model

1. Model output is untrusted input. Validated by schema, lossy by design.
2. Rendering is `textContent` only. `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `new Function` appear nowhere in the source (verified by grep; the one textual match is the comment in `ui.js` explaining the rule).
3. Model text is never executed, never used as a selector, never used as a URL.
4. The browser holds no API key — see §9.

### Demo mode

With no endpoint configured, `buildDemoPlan()` runs: a deterministic rule engine that reads the actual event inputs and reacts to them — it raises catering weight for complex dietary requirements, raises venue weight above 300 guests, flags a budget-per-head risk when the band is low against the guest count, and raises an accessibility-verification risk when accessibility needs are stated.

Demo output carries `source: 'demo'`, the banner is rendered **from that field**, and the notice text is a different string from the live one. A demo plan cannot be mistaken for a model response, because the label is a property of the plan object rather than something the UI has to remember to add.

## 6. Budget calculation methodology

**Representation.** Money is an integer number of paise everywhere. Rupees exist only at the input boundary (`toPaise`) and the formatting boundary (`formatINR`). `assertPaise()` throws on any non-integer, so a float can never propagate silently.

**Allocation.** Shares are computed with the largest-remainder (Hamilton) method: floor every share, then distribute the leftover units to the largest fractional remainders. The parts sum to the total exactly, at every budget size. This is tested against 1 paisa, 7 paise, ₹1,000.01 and ₹12,34,567.89.

Allocation runs on a **whole-rupee grain**: a category is never handed ₹2,30,679.61, because stray paise on a six-figure line are noise that makes a planner distrust the whole table. The emergency reserve is rounded to whole rupees too when the budget itself is whole rupees, so the allocatable remainder divides cleanly. If a total does arrive with stray paise — from an import, say — the sub-rupee remainder is parked deterministically on the largest category rather than dropped, and the sum still reconciles exactly. Internal maths stays in paise throughout; the grain only governs where boundaries fall.

**Three invariants**, asserted by tests:

- **I1** `sum(allocated) + reserve + unallocated === totalBudget` — exactly, always.
- **I2** `remaining === totalBudget − committed`, where `committed` is actual spend where it exists, otherwise the recorded estimate. That is the number a planner actually has to worry about.
- **I3** The total limit changes only through `setTotalBudget()`. Adding categories, editing allocations, changing the reserve, scaling guests — none of them move the ceiling.

`summarise()` returns a `reconciles` flag. If it is ever false, the overview renders a red "do not trust these figures" banner instead of pretending.

**Per-guest cost** is `allocated / guestCount`, and is `null` (displayed "N/A") at zero guests rather than `Infinity`.

## 7. Adaptive replanning logic

Changing guest count from 100 to 400 on a ₹8,00,000 budget:

1. `projectGuestCountChange()` scales only guest-sensitive categories (catering, venue, invitations, transport) by the ratio.
2. The projected total is compared against allocatable funds (total − reserve).
3. A dialog shows the per-category impact table, the shortfall in rupees, and restates your non-negotiables verbatim.
4. If you apply it anyway, **the ceiling holds.** Allocations are not inflated to cover the gap. Per-head spend drops, and a warning says so explicitly: *"Your budget ceiling was preserved, so per-head spend has dropped. Review the catering and venue standard."*

This is the central product decision. Most planners silently rescale to produce a plan that "works". CelebrAI states the trade-off and makes the user choose: raise the budget, cut the list, or accept a lower standard.

Date changes shift every deadline by the same delta and report how many tasks became overdue. Category edits redistribute across unlocked categories, and return `infeasible: true` — leaving the budget untouched — when the request cannot be funded. Vendor bookings move a quoted cost from estimate to actual automatically.

## 8. Installation and running

**Requirement:** Node.js ≥ 18 (only for the test runner and the optional server — the app itself needs nothing).

The quickest look is the hosted build: **https://mdibua.github.io/Celebrai/**. To run it locally:

```bash
git clone https://github.com/MdIbuA/Celebrai.git
cd Celebrai
npm test            # 86 unit tests, no install step, no dependencies
node server/proxy.js   # http://localhost:4173
```

`npm install` is not required; the dependency tree is empty.

A plain static server works too (`python3 -m http.server`). Opening `index.html` via `file://` will fail — ES modules require an HTTP origin. That is a browser rule, not a bug in the app.

### Configuration

Live AI mode is optional. The frontend accepts **a URL, never a key**:

```bash
cp .env.example .env
# edit .env: AI_PROVIDER=anthropic, ANTHROPIC_API_KEY=sk-...
node server/proxy.js
```

Then in **Settings → AI planning service**, set the endpoint to `/api/plan`. Leave it empty to stay in demo mode. `.env` is gitignored; `.env.example` contains no values.

### Demo mode limitations

Demo mode is fully functional — every deterministic feature works, and the plan is real output from a rule engine. What it is not:

- It is not a language model, and it says so on every screen that shows a plan.
- Its theme, food and activity suggestions come from a fixed per-category pool. They do not adapt to free-text preferences the way a model would.
- It does not read your cultural or theme free-text and synthesise around it; it uses the structured fields (category, guest count, budget band, dietary keywords, accessibility) only.

## 9. Security considerations

**The API-key problem, stated honestly.** A browser cannot keep a secret. Any key shipped to the client is readable in devtools, in the bundle and in network traffic; referrer restrictions are not a security control. CelebrAI therefore has **no API-key input field anywhere**. The Settings screen explains this and accepts only the URL of a server you control. `server/proxy.js` is that server: it reads the key from the environment and forwards the request. This is a documented architectural limitation of a browser-only app, handled with a real boundary rather than papered over.

Other measures, each verified by a test or a scan:

| Risk | Handling |
|---|---|
| XSS via model output or user text | `textContent` only; no `innerHTML`/`eval`/`new Function` in the codebase. Smoke test submits `<img src=x onerror=...>` as the event name and asserts no element is created and no handler fires |
| Prompt-injected instructions in model output | Output is data, never executed or used as a selector; unrecognised keys dropped |
| Secret leakage via export | Credential-shaped keys stripped recursively on both export and import; tested at depth |
| Malicious import file | Schema-validated, app-marker checked, size-capped at 5 MB, secrets stripped, user confirms replacement |
| Corrupt LocalStorage | Caught, backed up to a separate key, app boots to a clean state with an explanation |
| Storage quota exhaustion | Reported with an actionable message, never thrown |
| Path traversal on the server | Resolved path must stay under root; dotfiles and `node_modules` blocked (verified with `curl ../../etc/passwd` → 404) |
| Oversized request to the proxy | Body capped at 64 KB |
| Data minimisation | No names, phone numbers or addresses are required; the model receives neither the event name nor the exact budget |

A CSP header is served by `server/proxy.js` (`default-src 'self'`, no inline script).

**What CelebrAI explicitly does not claim:** it does not contact vendors, check availability, obtain quotations or know real market prices. Every vendor record is stamped `unverified-suggestion` until the user ticks "I have contacted this vendor". Every export carries that disclaimer in the file itself.

## 10. Accessibility

- Semantic HTML: `header`, `nav`, `main`, `section`, `fieldset`/`legend`, real `label` elements, `scope` on table headers.
- Skip link to main content.
- Full keyboard operation; `:focus-visible` outline is defined and never removed.
- Modal traps focus, closes on `Escape`, and restores focus to the trigger.
- Errors use `role="alert"` and `aria-invalid`; warnings use `aria-live="polite"`.
- Progress bars carry `role="progressbar"` and `aria-valuenow`.
- **No state is communicated by colour alone** — every status pill pairs a colour with a glyph and a text label ("▲ Overdue", "✓ Booked", "! Unverified").
- `prefers-reduced-motion` disables all animation.
- `prefers-color-scheme` light and dark themes; body colours set explicitly.
- Layout works from 320 px upward; sidebar collapses to a bottom tab bar at 880 px; touch targets are ≥ 40 px (52 px in the mobile nav).

Not yet done: a screen-reader pass with NVDA/VoiceOver, and a measured contrast audit. The palette was chosen for contrast but the ratios have not been instrument-verified. See Known limitations.

## 11. Testing

```bash
npm test                 # 86 unit tests, zero dependencies
```

**Actual result, last run on Node v22.22.0: 86 passed, 0 failed (26 ms).**

Coverage of the required cases:

| Required case | Where |
|---|---|
| Budget allocation totals | `budget.test.js` — reconciliation at five budget sizes |
| Budget exceeding the limit | `budget.test.js` — over-budget flag, negative remaining, warning code |
| Zero guests | `budget.test.js` (per-guest `null`), `timeline.test.js` (warning not block) |
| Invalid negative costs | `budget.test.js`, `ai-storage.test.js` (vendor quotes) |
| Currency rounding | `budget.test.js` — half-away-from-zero, float-drift comparison, largest remainder |
| Guest-count changes | `budget.test.js` — scaling, infeasibility, zero, invalid |
| Missing budget categories | `budget.test.js` — zero-allocation warning |
| Emergency reserve | `budget.test.js` — percentage, 0%, >50% rejection, limit preserved |
| Events in the past | `timeline.test.js` — warning + all tasks overdue |
| Short-notice events | `timeline.test.js` — compression inside the available window |
| Overdue tasks | `timeline.test.js` — including "completed is never overdue" |
| Timeline dependencies | `timeline.test.js` — derived blocking and automatic unblocking |
| Invalid AI responses | `ai-storage.test.js` — 9 tests incl. the money-rejection test |
| Malformed LocalStorage | `ai-storage.test.js` — corrupt, primitive, partial, future-version, quota, unavailable |
| Export/import validation | `ai-storage.test.js` — round-trip, wrong app, bad JSON, secret stripping |

### Headless end-to-end verification

```bash
npm i jsdom           # in a scratch folder — NOT a project dependency
NODE_PATH=<folder>/node_modules node tests/smoke-dom.js
```

This boots the real `index.html` + `app.js` against a DOM and drives the whole journey. **Actual result: 44 checks, 0 failures.** It verifies, among other things: the app boots; an empty form is rejected; a valid event creates a timeline and an auto-generated demo plan; the budget reconciles and the total equals what was typed; all six views render; an XSS payload in the event name is rendered as literal text and fires nothing; guest change 250 → 400 opens a trade-off dialog, quantifies the shortfall, restates the non-negotiables and preserves the ceiling; a date change recalculates every deadline; a vendor quote lands as an estimate and converts to actual on booking; state persists; export is valid JSON with the disclaimer and no key-shaped fields.

It is kept out of `npm test` deliberately: the brief asks for lightweight tests without unnecessary dependencies, and jsdom is a 50-package install. It skips cleanly with an explanatory message if jsdom is absent.

### Browser verification, and what the automated tests missed

No Chromium or Firefox binary existed in the build environment, so the app was written and tested entirely headlessly. jsdom does no layout and no paint.

It has since been opened on a real device — Chrome on Android, dark mode, against the hosted build — and that single look found a bug that 86 unit tests and 44 smoke checks had all passed straight through:

> `.modal { display: grid }` overrides the user-agent rule behind the `hidden` attribute, so the dialog panel and its page-dimming backdrop were painted over the entire application from first load.

Fixed in `a54dc6c` with a global `[hidden] { display: none !important }` rule. The accompanying regression check is a source-level assertion, not a computed-style one, because jsdom's cascade does not reproduce the bug — a `getComputedStyle` assertion passed against the broken stylesheet and would have been false confidence. The replacement was verified to fail without the fix.

Worth stating plainly, since it is the honest lesson of this build: **a fully green test suite told us nothing about whether the thing rendered.** Logic coverage and visual correctness are different properties, and only one of them was automated here.

Still unverified: iOS/Safari, light mode on a real device, measured contrast ratios, and screen-reader behaviour.

## 12. Known limitations

1. **Thinly visually verified.** One device, one browser, one theme (Chrome on Android, dark mode). iOS/Safari, desktop light mode and real contrast measurements are unchecked. See §11.
2. **No screenshots in the repo.** The hosted build is linked at the top instead; fabricating screenshots would undermine the point.
3. **No real vendor data.** By design, but it means the vendor module is a disciplined notebook, not a marketplace.
4. **Demo mode does not read free text.** It uses structured fields and keyword checks only.
5. **LocalStorage only.** Single browser, single device. Clearing site data loses everything not exported. No multi-user or sharing.
6. **Single event.** Creating a new one replaces the current one. The storage schema supports a list; the UI does not.
7. **No undo.** Destructive actions confirm, but there is no history.
8. **Cost templates are heuristics**, not market data, and they are India-generic rather than city-specific.
9. **Accessibility is implemented, not audited.** No screen-reader or contrast-ratio verification.
10. **The proxy is a reference implementation** — no auth, no rate limiting, no abuse protection. Do not expose it publicly as-is.
11. **Live mode is untested against a real provider.** The transport, schema gate, timeout, HTTP-error and network-error paths are tested with injected fetch stubs; no call has been made to Anthropic or OpenAI from this build.

## 13. Assumptions

- The user's budget is a hard ceiling unless they change it explicitly.
- `committed = actual ?? estimate` is the right definition of "spent" for planning purposes.
- Catering, venue, invitations and transport scale with headcount; photography, attire and audio largely do not.
- An emergency reserve belongs outside the category split, not inside it. 10% is a reasonable default.
- Users would rather be told something does not fit than be handed a plan that quietly assumes a lower standard.
- INR, `en-IN` formatting and Indian event categories. No multi-currency.
- One planner per browser; no concurrent editing.

## 14. Example workflow

1. **Create** — "Ayesha & Imran Nikah", wedding, 2027-02-14, Coimbatore, 250 guests, ₹8,00,000, 10% reserve, halal only with one Jain counter, wheelchair ramp needed, non-negotiable: nikah before 11am.
2. **Instantly** — ₹80,000 reserved; ₹7,20,000 split across eight categories; 15 timeline tasks generated backwards from the date; a demo plan appears with assumptions, risks and vendor questions. Because "Jain" appears in the dietary field, the demo engine nudges the catering weight from 30 to 33, so the split lands at catering ₹2,30,680, venue ₹1,74,757, decor ₹83,883, photography ₹69,903, attire ₹55,922, audio ₹41,942, transport ₹41,942, invitations ₹20,971. Per-guest allocation: ₹2,880.
3. **Record a vendor** — banquet hall, quoted ₹1,75,000. It lands in the venue category as an estimate — and immediately flags as an overrun, because venue is only allocated ₹1,74,757. Mark it booked; it becomes actual spend.
4. **Guest count rises to 400** — a dialog shows catering projected ₹2,30,680 → ₹3,69,088, venue ₹1,74,757 → ₹2,79,611, transport and invitations likewise, a shortfall of ₹2,81,010, your non-negotiable restated, and three honest options. Apply it: the ceiling holds, per-head drops to ₹1,800, and the warning says exactly that.
5. **Date moves to April** — all 15 deadlines shift by 59 days; the app reports how many are now overdue.
6. **Export** — a JSON file with everything, carrying the "these are not confirmed quotations" disclaimer, with no credential-shaped field anywhere in it.

## 15. Screenshots

None committed. The app is hosted and takes no setup to try, so a live link beats a static image: **https://mdibua.github.io/Celebrai/**

It opens on the event-creation form. Fill it in and the overview, budget breakdown, timeline and vendor checklist all populate immediately — no key, no sign-in, no backend.

Licence: MIT.
