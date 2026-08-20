import { icon } from '../icons.js';
import { esc, normalise, prettyNumber, sameNumber } from '../format.js';
import { playDtmf } from '../audio.js';
import { state } from '../store.js';
import * as phone from '../phone.js';
import { toast } from './toast.js';

const KEYS = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

let root = null;
let input = null;
let onPlaceCall = null;

export function init(el, { placeCall }) {
  root = el;
  onPlaceCall = placeCall;

  root.innerHTML = `
    <div class="dial-display">
      <div class="dial-number">
        <input id="dialInput" placeholder="Enter a number" spellcheck="false" autocomplete="off" />
        <button class="backspace" id="dialBack" title="Delete" aria-label="Delete">
          ${icon('backspace', 20)}
        </button>
      </div>
      <div class="dial-hint" id="dialHint"></div>
    </div>

    <div class="keypad" id="keypad">
      ${KEYS.map(
        ([d, letters]) => `
        <button class="key" data-key="${d}">
          <span class="digit">${d}</span>
          <span class="letters">${letters}</span>
        </button>`
      ).join('')}
    </div>

    <div class="call-actions">
      <button class="call-btn" id="dialCall" title="Call" aria-label="Call">
        ${icon('phone', 27, 2)}
      </button>
    </div>

    <div class="dial-foot">
      <span>Type to dial</span><kbd>Enter</kbd><span>to call</span><kbd>Esc</kbd><span>to clear</span>
    </div>`;

  input = root.querySelector('#dialInput');

  root.querySelector('#keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('.key');
    if (btn) press(btn.dataset.key);
  });

  // Hold 0 for +, the convention every phone keypad uses.
  let holdTimer = null;
  root.querySelector('#keypad').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.key');
    if (btn?.dataset.key !== '0') return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      input.value = input.value.slice(0, -1) + '+';
      refresh();
    }, 550);
  });
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
  };
  root.querySelector('#keypad').addEventListener('pointerup', cancelHold);
  root.querySelector('#keypad').addEventListener('pointerleave', cancelHold);

  root.querySelector('#dialBack').onclick = () => {
    input.value = input.value.slice(0, -1);
    refresh();
  };
  // Clear the whole field, which is the other thing people want from a
  // backspace button on a dialpad.
  root.querySelector('#dialBack').oncontextmenu = (e) => {
    e.preventDefault();
    input.value = '';
    refresh();
  };

  root.querySelector('#dialCall').onclick = placeCallNow;

  input.addEventListener('input', () => {
    // Keep it dialable, but let a pasted "+30 211 444 3742" survive.
    input.value = input.value.replace(/[^\d*#+\s()-]/g, '');
    refresh();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      placeCallNow();
    }
    if (e.key === 'Escape') {
      input.value = '';
      refresh();
    }
  });

  refresh();
}

/** Append a key, with the tone and the press animation. */
function press(key) {
  playDtmf(key);
  input.value += key;
  const btn = root.querySelector(`.key[data-key="${CSS.escape(key)}"]`);
  if (btn) {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 110);
  }
  refresh();
}

function placeCallNow() {
  const number = normalise(input.value);
  if (!number) return;
  const match = state.contacts.find((c) => sameNumber(c.number, number));
  const err = onPlaceCall(number, match?.name || '');
  if (err) toast(err, 'error');
  else input.value = '';
  refresh();
}

/** Update everything that depends on the current input or registration. */
export function refresh() {
  if (!root) return;
  const raw = input.value;
  const number = normalise(raw);
  root.querySelector('#dialBack').classList.toggle('on', raw.length > 0);

  const registered = state.registration.state === 'registered';
  const callBtn = root.querySelector('#dialCall');
  callBtn.disabled = !number || !registered;
  callBtn.title = !registered ? 'Not registered — check Settings' : 'Call';

  const hint = root.querySelector('#dialHint');
  const match = number ? state.contacts.find((c) => sameNumber(c.number, number)) : null;
  if (match) {
    hint.innerHTML = `${icon('user', 13)}<b>${esc(match.name)}</b>`;
  } else if (!registered) {
    hint.innerHTML = `<span style="color:var(--text-3)">Not registered — open Settings to connect</span>`;
  } else if (number.length > 5) {
    hint.innerHTML = `<span style="color:var(--text-3)">${esc(prettyNumber(number))}</span>`;
  } else {
    hint.innerHTML = '';
  }
}

/** Called when another view wants a number teed up here. */
export function setNumber(n) {
  if (!input) return;
  input.value = n || '';
  refresh();
  input.focus();
}

/** Typing anywhere in the app that isn't a field goes to the dialpad — the
 *  behaviour people expect from a phone, and it removes a click. */
export function handleGlobalKey(e) {
  if (!root || !root.classList.contains('active')) return false;
  if (e.target.matches('input, textarea, select')) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;

  if (/^[0-9*#]$/.test(e.key)) {
    press(e.key);
    return true;
  }
  if (e.key === '+') {
    input.value += '+';
    refresh();
    return true;
  }
  if (e.key === 'Backspace') {
    input.value = input.value.slice(0, -1);
    refresh();
    return true;
  }
  if (e.key === 'Enter') {
    placeCallNow();
    return true;
  }
  if (e.key === 'Escape' && input.value) {
    input.value = '';
    refresh();
    return true;
  }
  return false;
}
