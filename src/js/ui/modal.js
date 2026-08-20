import { esc } from '../format.js';

const scrim = () => document.getElementById('scrim');
let closeCurrent = null;

/**
 * A modal that resolves a promise: `null` when dismissed, otherwise whatever
 * the confirm button produced.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body          innerHTML for the body — callers escape
 * @param {string} [opts.confirmText]
 * @param {string} [opts.confirmClass]
 * @param {(root: HTMLElement) => any} [opts.onConfirm] return a falsy value to
 *        keep the modal open (used for validation)
 * @param {(root: HTMLElement) => void} [opts.onMount]
 */
export function modal(opts) {
  closeCurrent?.();

  return new Promise((resolve) => {
    const root = scrim();
    root.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header><h3>${esc(opts.title)}</h3></header>
        <div class="modal-body">${opts.body}</div>
        <footer>
          <button class="btn ghost" data-act="cancel">${esc(opts.cancelText || 'Cancel')}</button>
          <button class="btn ${opts.confirmClass || 'primary'}" data-act="ok">${esc(
            opts.confirmText || 'Save'
          )}</button>
        </footer>
      </div>`;
    root.classList.add('on');

    const done = (value) => {
      closeCurrent = null;
      root.classList.remove('on');
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    closeCurrent = () => done(null);

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
      // Enter submits, except from a textarea where it means a new line.
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        confirm();
      }
    }

    function confirm() {
      const value = opts.onConfirm ? opts.onConfirm(root) : true;
      if (value) done(value);
    }

    root.querySelector('[data-act="cancel"]').onclick = () => done(null);
    root.querySelector('[data-act="ok"]').onclick = confirm;
    // Clicking the backdrop dismisses; clicking inside the card must not.
    root.onclick = (e) => {
      if (e.target === root) done(null);
    };
    document.addEventListener('keydown', onKey, true);

    opts.onMount?.(root);
    root.querySelector('input, textarea, select')?.focus();
  });
}

/** Yes/no, for anything destructive. */
export function confirmDialog({ title, message, confirmText = 'Delete', danger = true }) {
  return modal({
    title,
    body: `<p style="margin:0;color:var(--text-2);line-height:1.6">${esc(message)}</p>`,
    confirmText,
    confirmClass: danger ? 'danger' : 'primary',
    onConfirm: () => true,
  });
}
