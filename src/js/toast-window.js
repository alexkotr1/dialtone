/**
 * The incoming-call popup's renderer.
 *
 * Deliberately tiny and self-contained: it owns no call state and makes no
 * decisions. It renders what main tells it and reports back which button was
 * pressed. Everything about the call itself stays in the main window, which
 * is the only place holding a SIP session.
 */

import { icon } from './icons.js';
import { duration, esc, hue, initials, prettyNumber } from './format.js';

const api = window.dialtoneToast;

const nameEl = document.getElementById('name');
const statusEl = document.getElementById('status');
const avatarEl = document.getElementById('avatar');
const actionsEl = document.getElementById('actions');

function avatar(name, seed) {
  const label = initials(name);
  if (!label) {
    return `<div class="avatar unknown">${icon('user', 20)}</div>`;
  }
  return `<div class="avatar" style="--h:${hue(seed || name)}">${esc(label)}</div>`;
}

function render(call) {
  const title = call.name || prettyNumber(call.number) || 'Unknown';
  nameEl.textContent = title;
  avatarEl.innerHTML = avatar(call.name, call.name || call.number);

  if (call.status === 'connected') {
    statusEl.innerHTML = `<i class="dot"></i>${esc(duration(call.seconds || 0))}`;
    actionsEl.innerHTML = `
      <button class="act decline" id="hangup" title="Hang up">
        ${icon('phoneOff', 19, 2)}
      </button>`;
    document.getElementById('hangup').onclick = () => api.hangup();
    return;
  }

  // Ringing. Show the number under the name when we resolved a contact, so it
  // is clear which line is being called.
  statusEl.innerHTML = call.name
    ? `Incoming &middot; ${esc(prettyNumber(call.number))}`
    : 'Incoming call';
  actionsEl.innerHTML = `
    <button class="act decline" id="decline" title="Decline">
      ${icon('phoneOff', 19, 2)}
    </button>
    <button class="act answer ringing" id="answer" title="Answer">
      ${icon('phone', 19, 2)}
    </button>`;
  document.getElementById('decline').onclick = () => api.decline();
  document.getElementById('answer').onclick = () => api.answer();
}

api.onCall((call) => {
  render(call);
});

api.onTheme((theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

// The slide-out is the window moving, driven from main; nothing to animate
// here. The hook stays so main has a single place to hang teardown if the
// card ever needs to change on the way out.
api.onDismiss(() => {
  api.dismissed();
});

// Clicking the card (but not a button) brings the app forward.
document.querySelector('.who').onclick = () => api.open();
