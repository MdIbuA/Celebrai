/**
 * storage.js — LocalStorage persistence with defensive reads.
 *
 * Assumptions that have burned other apps and are handled here:
 *  - localStorage can be entirely absent (Safari private mode, embedded views)
 *  - the stored string can be corrupt (a half-written tab, a user editing it)
 *  - setItem can throw QuotaExceededError
 *  - the schema will change, so every record is versioned
 */

export const STORAGE_KEY = 'celebrai.state.v1';
export const SCHEMA_VERSION = 1;

/** In-memory fallback so the app keeps working when storage is unavailable. */
function createMemoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    __memory: true,
  };
}

export function resolveStore(preferred) {
  if (preferred) return preferred;
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return createMemoryStore();
    const probe = '__celebrai_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return createMemoryStore();
  }
}

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    event: null,
    budget: null,
    expenses: [],
    tasks: [],
    vendors: [],
    plan: null,
    preferences: { theme: 'system', lastView: 'overview' },
    updatedAt: null,
  };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Load state. Never throws. Returns the state plus a diagnostic so the UI can
 * tell the user that their saved data was unreadable instead of silently
 * resetting it.
 */
export function loadState(store = resolveStore()) {
  const base = emptyState();
  let raw = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch (err) {
    return { state: base, status: 'unavailable', message: `Storage could not be read: ${err.message}` };
  }

  if (raw === null || raw === undefined || raw === '') {
    return { state: base, status: 'empty', message: 'No saved event yet.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: base,
      status: 'corrupt',
      message: 'Saved data was corrupted and could not be read. A backup copy has been kept under "celebrai.corrupt-backup".',
      recovered: backupCorrupt(store, raw),
    };
  }

  if (!isPlainObject(parsed)) {
    return { state: base, status: 'corrupt', message: 'Saved data had an unexpected shape and was ignored.' };
  }

  if (Number(parsed.schemaVersion) > SCHEMA_VERSION) {
    return {
      state: base,
      status: 'future-version',
      message: `Saved data uses schema v${parsed.schemaVersion}; this build understands v${SCHEMA_VERSION}. Data was left untouched and not loaded.`,
    };
  }

  // Merge field by field so a missing or mistyped key cannot crash the app.
  const state = {
    ...base,
    schemaVersion: SCHEMA_VERSION,
    event: isPlainObject(parsed.event) ? parsed.event : null,
    budget: isPlainObject(parsed.budget) ? parsed.budget : null,
    expenses: Array.isArray(parsed.expenses) ? parsed.expenses.filter(isPlainObject) : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isPlainObject) : [],
    vendors: Array.isArray(parsed.vendors) ? parsed.vendors.filter(isPlainObject) : [],
    plan: isPlainObject(parsed.plan) ? parsed.plan : null,
    preferences: isPlainObject(parsed.preferences) ? { ...base.preferences, ...parsed.preferences } : base.preferences,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  };

  const partial = ['event', 'budget', 'expenses', 'tasks', 'vendors'].some(
    (k) => k in parsed && JSON.stringify(parsed[k]) !== JSON.stringify(state[k]),
  );

  return {
    state,
    status: partial ? 'partial' : 'ok',
    message: partial ? 'Some saved fields were malformed and were reset to defaults.' : 'Loaded saved event.',
  };
}

function backupCorrupt(store, raw) {
  try {
    store.setItem('celebrai.corrupt-backup', String(raw).slice(0, 200000));
    return true;
  } catch {
    return false;
  }
}

/** Persist state. Returns { ok, message } rather than throwing. */
export function saveState(state, store = resolveStore()) {
  const payload = { ...state, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  let serialised;
  try {
    serialised = JSON.stringify(payload);
  } catch (err) {
    return { ok: false, message: `Could not serialise state: ${err.message}` };
  }
  try {
    store.setItem(STORAGE_KEY, serialised);
    return { ok: true, message: 'Saved locally.', bytes: serialised.length };
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      quota: Boolean(quota),
      message: quota
        ? 'Browser storage is full. Export your plan to a file, then clear old data.'
        : `Could not save locally: ${err.message}`,
    };
  }
}

export function clearState(store = resolveStore()) {
  try {
    store.removeItem(STORAGE_KEY);
    return { ok: true, message: 'Local event data deleted.' };
  } catch (err) {
    return { ok: false, message: `Could not clear storage: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ *
 * Export / import payloads
 * ------------------------------------------------------------------ */

const EXPORT_DENYLIST = ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization', 'endpointKey'];

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (EXPORT_DENYLIST.some((bad) => k.toLowerCase().includes(bad.toLowerCase()))) continue;
    out[k] = stripSecrets(v);
  }
  return out;
}

/** Build the downloadable export payload. Secrets are structurally excluded. */
export function buildExport(state) {
  return stripSecrets({
    app: 'CelebrAI',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    event: state.event,
    budget: state.budget,
    expenses: state.expenses,
    tasks: state.tasks,
    vendors: state.vendors,
    plan: state.plan,
    disclaimer:
      'Costs in this file are user-entered figures or planning estimates. They are not confirmed vendor quotations, and no vendor availability has been verified.',
  });
}
