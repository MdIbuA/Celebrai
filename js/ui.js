/**
 * ui.js — safe DOM construction helpers.
 *
 * Hard rule for this file and every caller: untrusted text (user input, model
 * output, imported files) is placed with textContent only. `innerHTML` is not
 * used anywhere in CelebrAI — grep for it; the only occurrences are in this
 * comment. That removes the XSS class of bug by construction rather than by
 * sanitisation, which is the kind of defence that survives refactors.
 */

/**
 * Create an element.
 * @param {string} tag
 * @param {object} props  className, attrs, dataset, on{Event}, text
 * @param {Array<Node|string|null|false>} children  strings become text nodes
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value); // always safe
    } else if (key === 'dataset') {
      for (const [d, v] of Object.entries(value)) node.dataset[d] = String(v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'hidden') {
      node.hidden = Boolean(value);
    } else if (key in node && typeof node[key] !== 'object' && key !== 'style') {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const c of children.flat()) if (c) node.appendChild(c);
  return node;
}

/* ───────────────── Reusable blocks ───────────────── */

export function card(title, children, { note, actions } = {}) {
  const head = title || actions
    ? el('div', { class: 'card__head' }, [
        title ? el('h2', { class: 'card__title', text: title }) : null,
        actions ? el('div', { class: 'view__actions' }, actions) : null,
      ])
    : null;
  return el('section', { class: 'card' }, [
    head,
    note ? el('p', { class: 'card__note', text: note }) : null,
    ...[].concat(children),
  ]);
}

/** Status pill. Glyph + text, so meaning never depends on colour alone. */
export function pill(label, tone = 'muted', glyph = '') {
  return el('span', { class: `pill pill--${tone}` }, [
    glyph ? el('span', { 'aria-hidden': 'true', text: glyph }) : null,
    el('span', { text: label }),
  ]);
}

const NOTICE_GLYPH = { warn: '!', danger: '✕', ok: '✓', info: 'i' };

export function notice(message, tone = 'info', { strongPrefix } = {}) {
  return el('div', { class: `notice notice--${tone}`, role: tone === 'danger' ? 'alert' : null }, [
    el('span', { class: 'notice__icon', 'aria-hidden': 'true', text: NOTICE_GLYPH[tone] ?? 'i' }),
    el('span', { class: 'notice__body' }, [
      strongPrefix ? el('strong', { text: `${strongPrefix} ` }) : null,
      message, // text node — safe
    ]),
  ]);
}

export function stat(label, value, { meta, tone, bar } = {}) {
  return el('div', { class: `stat${tone ? ` stat--${tone}` : ''}` }, [
    el('div', { class: 'stat__label', text: label }),
    el('div', { class: 'stat__value', text: value }),
    meta ? el('div', { class: 'stat__meta', text: meta }) : null,
    bar ? progressBar(bar.percent, bar.tone) : null,
  ]);
}

export function progressBar(percent, tone = '') {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return el('div', {
    class: 'bar',
    role: 'progressbar',
    'aria-valuenow': String(Math.round(clamped)),
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  }, [
    el('div', { class: `bar__fill${tone ? ` bar__fill--${tone}` : ''}`, style: `width:${clamped}%` }),
  ]);
}

export function emptyState(title, body, actionLabel, onAction) {
  return el('div', { class: 'empty' }, [
    el('span', { class: 'empty__mark', 'aria-hidden': 'true', text: '✦' }),
    el('p', { class: 'empty__title', text: title }),
    el('p', { text: body }),
    actionLabel ? el('button', { class: 'btn btn--primary', type: 'button', onClick: onAction, text: actionLabel }) : null,
  ]);
}

export function skeleton(lines = 4) {
  return el('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: lines }, (_, i) => el('div', { class: 'skeleton__bar', style: `width:${100 - i * 12}%` })));
}

export function bulletList(items) {
  if (!items || items.length === 0) return el('p', { class: 'field__hint', text: 'Nothing recorded here.' });
  return el('ul', { class: 'list' }, items.map((t) => el('li', {}, [el('span', { text: String(t) })])));
}

export function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {
        class: h.numeric ? 'num' : null,
        scope: 'col',
        text: h.label ?? h,
      })))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

/* ───────────────── Toasts ───────────────── */

const TOAST_GLYPH = { ok: '✓', warn: '!', danger: '✕', info: 'i' };

export function toast(message, tone = 'info', { timeout = 5200 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast toast--${tone}` }, [
    el('span', { class: 'toast__icon', 'aria-hidden': 'true', text: TOAST_GLYPH[tone] ?? 'i' }),
    el('span', { text: message }),
  ]);
  host.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

/* ───────────────── Modal ───────────────── */

let lastFocused = null;

export function openModal({ title, body, actions }) {
  const modal = document.getElementById('modal');
  lastFocused = document.activeElement;
  document.getElementById('modalTitle').textContent = title;
  mount(document.getElementById('modalBody'), ...[].concat(body));
  mount(document.getElementById('modalActions'), ...actions);
  modal.hidden = false;
  const first = modal.querySelector('button, input, select, textarea');
  first?.focus();
  document.addEventListener('keydown', onModalKey);
}

export function closeModal() {
  const modal = document.getElementById('modal');
  modal.hidden = true;
  document.removeEventListener('keydown', onModalKey);
  lastFocused?.focus();
}

function onModalKey(event) {
  if (event.key === 'Escape') { closeModal(); return; }
  if (event.key !== 'Tab') return;
  // Focus trap.
  const panel = document.querySelector('.modal__panel');
  const focusables = panel.querySelectorAll('button, input, select, textarea, [href]');
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: [el('p', { text: message })],
      actions: [
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: 'Cancel',
          onClick: () => { closeModal(); resolve(false); },
        }),
        el('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button', text: confirmLabel,
          onClick: () => { closeModal(); resolve(true); },
        }),
      ],
    });
  });
}

document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLElement && e.target.dataset.close === '1') closeModal();
});
