import { icon } from '../icons.js';
import { esc } from '../format.js';

const host = () => document.getElementById('toasts');

/**
 * Transient feedback. Used for things that succeeded quietly or failed
 * harmlessly — never for anything the person has to act on, which belongs in
 * the view that caused it.
 */
export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const glyph = kind === 'error' ? icon('info', 15) : kind === 'ok' ? icon('check', 15) : '';
  el.innerHTML = `${glyph}<span>${esc(message)}</span>`;
  host().appendChild(el);

  const ms = kind === 'error' ? 5200 : 2600;
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}
