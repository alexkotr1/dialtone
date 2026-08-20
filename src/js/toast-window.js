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

const card = document.getElementById('card');
const nameEl = document.getElementById('name');
const statusEl = document.getElementById('status');
const avatarEl = document.getElementById('avatar');
const actionsEl = document.getElementById('actions');

/** Whether the slide-in has been played, so a stream of updates does not
 *  restart the animation on every tick. */
let shown = false;

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
  if (!shown) {
    shown = true;
    card.classList.remove('out');
    // Force a style flush so the browser has the card's off-screen position
    // as a starting value, then change it — that is what makes the move a
    // transition rather than an instant jump.
    //
    // Deliberately synchronous. The obvious version schedules this on a
    // requestAnimationFrame, and Chromium does not run those for a window
    // that is not on screen — leaving the card parked off-screen at opacity 0
    // inside a transparent window, which looks exactly like the popup opening
    // behind everything else.
    void card.offsetWidth;
    card.classList.add('in');
  }
});

api.onTheme((theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

api.onDismiss(() => {
  shown = false;
  card.classList.remove('in');
  card.classList.add('out');
  // Tell main once the card is actually off-screen so the window is hidden
  // only after the animation, not during it.
  const done = () => api.dismissed();
  card.addEventListener('transitionend', done, { once: true });
  // A window that never gets a transitionend — hidden tab, reduced motion —
  // must not leave the popup stuck on screen.
  setTimeout(done, 500);
});

// Clicking the card (but not a button) brings the app forward.
document.querySelector('.who').onclick = () => api.open();
