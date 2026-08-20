/** Formatting helpers. Everything user-visible that isn't a component. */

/** Strip a number down to what can be dialled. Keeps a leading +, and keeps
 *  * and # because they are real DTMF keys, not punctuation. */
export function normalise(raw) {
  const s = String(raw || '').trim();
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d*#]/g, '');
}

/** Two numbers are "the same" for matching purposes if their last 8 digits
 *  agree. Callers arrive as +30211…, 0211…, and 211… for the same line, and
 *  a call log that lists one person three times is worse than a rare false
 *  match on a short extension. Extensions (< 8 digits) compare exactly. */
export function sameNumber(a, b) {
  const da = normalise(a).replace(/\D/g, '');
  const db = normalise(b).replace(/\D/g, '');
  if (!da || !db) return false;
  if (da.length < 8 || db.length < 8) return da === db;
  return da.slice(-8) === db.slice(-8);
}

/** Group digits so a long number is readable at a glance. Deliberately
 *  format-agnostic — guessing a national convention wrongly is worse than
 *  even grouping. Short strings are extensions and are left alone. */
export function prettyNumber(raw) {
  const s = normalise(raw);
  if (s.length <= 5) return s;
  const plus = s.startsWith('+');
  const digits = plus ? s.slice(1) : s;
  if (/[*#]/.test(digits)) return s;
  const groups = [];
  let rest = digits;
  if (plus && rest.length > 9) {
    groups.push(rest.slice(0, 2));
    rest = rest.slice(2);
  }
  while (rest.length > 0) {
    const take = rest.length > 4 ? 3 : rest.length;
    groups.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return (plus ? '+' : '') + groups.join(' ');
}

/** mm:ss, or h:mm:ss once a call passes an hour. */
export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** "3 min 20 sec" — for the call log, where a bare 03:20 reads as a time. */
export function durationWords(seconds) {
  const s = Math.floor(seconds || 0);
  if (s <= 0) return '';
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} sec` : `${m} min`;
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateLong = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dateShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export function clock(ts) {
  return time.format(new Date(ts));
}

/** The heading a call belongs under: Today, Yesterday, a weekday inside the
 *  last week, then a date. */
export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(d);
  return dateLong.format(d);
}

/** Compact stamp for a list row: the time if today, otherwise a short date. */
export function shortStamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  return sameDay ? time.format(d) : dateShort.format(d);
}

export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic hue from a string, so a contact keeps its colour forever. */
export function hue(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Escape before interpolating anything user-supplied into innerHTML.
 *  Contact names and SIP display names both arrive from outside this app. */
export function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
