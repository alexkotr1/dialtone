/**
 * Application state, and the only thing that writes it to disk.
 *
 * A tiny pub/sub rather than a framework: there are three collections and one
 * settings object, and every view redraws from them. Saves are debounced so
 * that typing in a settings field is not a write per keystroke.
 */

const api = window.dialtone;

const DEFAULT_SETTINGS = {
  displayName: '',
  username: '',
  password: '',
  domain: '',
  wsUrl: '',
  stun: 'stun:stun.l.google.com:19302',
  autoConnect: false,
  theme: 'dark',
  micDeviceId: '',
  speakerDeviceId: '',
  /** Close the window to the tray instead of quitting. */
  keepInTray: true,
  /** Show the corner popup when a call arrives and the app is not in front. */
  callPopup: true,
  /** Output levels, 0..1. 0.6 is the loudness these sounds always had. */
  ringVolume: 0.6,
  toneVolume: 0.6,
};

const listeners = new Set();

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  contacts: [],
  history: [],
  encryptionAvailable: false,
  /** Populated by phone.js; views read it but never write it. */
  registration: { state: 'idle', detail: '' },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(what = 'all') {
  for (const fn of listeners) fn(what);
}

export async function load() {
  const data = await api.store.load();
  const stored = { ...(data.settings || {}) };
  // `focusOnCall` raised the main window; it was replaced by the corner
  // popup. Carry the old preference over rather than silently re-enabling
  // something for someone who had turned it off.
  if (stored.focusOnCall !== undefined && stored.callPopup === undefined) {
    stored.callPopup = stored.focusOnCall;
  }
  delete stored.focusOnCall;
  state.settings = { ...DEFAULT_SETTINGS, ...stored };
  state.contacts = Array.isArray(data.contacts) ? data.contacts : [];
  state.history = Array.isArray(data.history) ? data.history : [];
  state.encryptionAvailable = !!data.encryptionAvailable;
  emit('all');
}

/** Debounce per key so a burst of contact edits and a burst of settings
 *  edits don't cancel each other out. */
const timers = new Map();
function debounce(key, fn, ms = 250) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(fn, ms));
}

export function saveSettings(patch = {}) {
  Object.assign(state.settings, patch);
  emit('settings');
  return new Promise((resolve) => {
    debounce('settings', async () => resolve(await api.store.saveSettings(state.settings)));
  });
}

export function saveContacts() {
  emit('contacts');
  debounce('contacts', () => api.store.saveContacts(state.contacts));
}

export function saveHistory() {
  emit('history');
  debounce('history', () => api.store.saveHistory(state.history));
}

// --- contacts -------------------------------------------------------------

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function addContact(c) {
  const contact = {
    id: id(),
    name: (c.name || '').trim(),
    number: (c.number || '').trim(),
    company: (c.company || '').trim(),
    note: (c.note || '').trim(),
    favorite: !!c.favorite,
    createdAt: Date.now(),
  };
  state.contacts.push(contact);
  saveContacts();
  return contact;
}

export function updateContact(contactId, patch) {
  const c = state.contacts.find((x) => x.id === contactId);
  if (!c) return null;
  Object.assign(c, patch);
  saveContacts();
  return c;
}

export function deleteContact(contactId) {
  const i = state.contacts.findIndex((x) => x.id === contactId);
  if (i < 0) return;
  state.contacts.splice(i, 1);
  saveContacts();
}

// --- history --------------------------------------------------------------

/** Cap the log. Unbounded growth would eventually make startup slow, and
 *  nobody scrolls two thousand calls back. */
const HISTORY_LIMIT = 1000;

export function addCall(entry) {
  const call = {
    id: id(),
    number: entry.number || '',
    name: entry.name || '',
    direction: entry.direction, // 'in' | 'out' | 'missed'
    startedAt: entry.startedAt || Date.now(),
    duration: entry.duration || 0,
  };
  state.history.unshift(call);
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  saveHistory();
  return call;
}

export function deleteCall(callId) {
  const i = state.history.findIndex((x) => x.id === callId);
  if (i < 0) return;
  state.history.splice(i, 1);
  saveHistory();
}

export function clearHistory() {
  state.history.length = 0;
  saveHistory();
}

// --- import ---------------------------------------------------------------

/**
 * Apply an imported bundle.
 *
 * @param {object} bundle   as returned by the main process, already validated
 * @param {'replace'|'merge'} mode
 *
 * `replace` is a straight overwrite. `merge` keeps what is here and adds only
 * what is genuinely new — contacts matched on number so re-importing your own
 * export is a no-op rather than a way to double every entry, and calls matched
 * on id.
 */
export async function applyImport(bundle, mode = 'merge') {
  const added = { contacts: 0, history: 0 };

  if (mode === 'replace') {
    state.contacts = bundle.contacts.slice();
    state.history = bundle.history.slice();
    added.contacts = state.contacts.length;
    added.history = state.history.length;
  } else {
    const { sameNumber } = await import('./format.js');
    for (const c of bundle.contacts) {
      if (state.contacts.some((x) => sameNumber(x.number, c.number))) continue;
      state.contacts.push({ ...c, id: c.id || id() });
      added.contacts++;
    }
    const seen = new Set(state.history.map((h) => h.id));
    for (const h of bundle.history) {
      if (h.id && seen.has(h.id)) continue;
      state.history.push({ ...h, id: h.id || id() });
      added.history++;
    }
    state.history.sort((a, b) => b.startedAt - a.startedAt);
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  }

  // Settings always replace: half-merged connection details would produce an
  // account that is neither the old one nor the new one.
  const incoming = { ...bundle.settings };
  // An export made without the password must not wipe the one already here.
  if (!bundle.passwordIncluded || !incoming.password) {
    incoming.password = state.settings.password;
  }
  await saveSettings({ ...DEFAULT_SETTINGS, ...incoming });

  saveContacts();
  saveHistory();
  emit('all');
  return added;
}

/** True once there is enough to attempt a registration. Used to disable the
 *  Connect button rather than letting it fail in a way that looks like a
 *  server problem. */
export function isConfigured(s = state.settings) {
  return !!(s.wsUrl && s.username && s.domain);
}
