import { icon } from '../icons.js';
import { duration, esc, prettyNumber, sameNumber } from '../format.js';
import { playDtmf } from '../audio.js';
import { state } from '../store.js';
import * as phone from '../phone.js';
import { avatar } from './avatar.js';

const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

let root = null;
let padOpen = false;
let padSent = '';
let onDismiss = null;

export function init(el, { dismiss }) {
  root = el;
  onDismiss = dismiss;
  root.innerHTML = `
    <div class="who">
      <div id="csAvatar"></div>
      <h2 id="csName"></h2>
      <div class="status" id="csStatus"></div>
    </div>

    <div>
      <div class="call-controls" id="csControls">
        <button class="cc" data-act="mute">
          <span class="ring" id="csMuteIcon">${icon('mic', 22)}</span>
          <span id="csMuteLabel">Mute</span>
        </button>
        <button class="cc" data-act="pad">
          <span class="ring">${icon('dialpad', 20)}</span>
          <span>Keypad</span>
        </button>
        <button class="cc" data-act="hold">
          <span class="ring" id="csHoldIcon">${icon('pause', 20)}</span>
          <span id="csHoldLabel">Hold</span>
        </button>
      </div>

      <div class="call-end-row" id="csEndRow"></div>
    </div>

    <div class="incall-pad" id="csPad">
      <div class="sent" id="csPadSent"></div>
      <div class="keypad">
        ${PAD.map((d) => `<button class="key" data-dtmf="${d}"><span class="digit">${d}</span></button>`).join('')}
      </div>
      <button class="btn ghost" id="csPadClose">Hide keypad</button>
    </div>`;

  root.querySelector('#csControls').addEventListener('click', (e) => {
    const btn = e.target.closest('.cc');
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === 'mute') phone.toggleMute();
    if (btn.dataset.act === 'hold') phone.toggleHold();
    if (btn.dataset.act === 'pad') togglePad();
  });

  root.querySelector('#csPad').addEventListener('click', (e) => {
    const key = e.target.closest('[data-dtmf]');
    if (!key) return;
    const digit = key.dataset.dtmf;
    playDtmf(digit);
    if (phone.sendDtmf(digit)) {
      padSent += digit;
      root.querySelector('#csPadSent').textContent = padSent;
    }
  });
  root.querySelector('#csPadClose').onclick = () => togglePad(false);
}

function togglePad(force) {
  padOpen = force === undefined ? !padOpen : force;
  root.querySelector('#csPad').classList.toggle('on', padOpen);
  root.querySelector('[data-act="pad"]').classList.toggle('active', padOpen);
}

/** Render from the phone's snapshot. Called on every call event. */
export function render(call) {
  if (!root) return;

  const visible = call.active && call.status !== 'ended';
  root.classList.toggle('on', visible);
  if (!visible) {
    padOpen = false;
    padSent = '';
    root.querySelector('#csPad').classList.remove('on');
    root.querySelector('#csPadSent').textContent = '';
    return;
  }

  const contact = state.contacts.find((c) => sameNumber(c.number, call.number));
  const title = contact?.name || call.name || prettyNumber(call.number) || 'Unknown';
  const ringing = call.status === 'calling' || call.status === 'ringing';

  root.querySelector('#csAvatar').innerHTML = `
    <div class="${ringing ? 'ringing-halo' : ''}">
      ${avatar(contact?.name || call.name, { size: 'xl', seed: contact?.name || call.number })}
    </div>`;

  root.querySelector('#csName').textContent = title;

  const status = root.querySelector('#csStatus');
  if (call.status === 'calling') {
    status.innerHTML = `Calling…`;
  } else if (call.status === 'ringing') {
    status.innerHTML =
      call.direction === 'in'
        ? `<i class="dot"></i>Incoming call`
        : `<i class="dot"></i>Ringing…`;
  } else if (call.onHold) {
    status.innerHTML = `On hold · ${esc(duration(call.seconds))}`;
  } else {
    status.innerHTML = `<i class="dot"></i>${esc(duration(call.seconds))}`;
  }

  // Show the number under the name when we resolved it to a person, so the
  // line being used is never a mystery.
  if ((contact || call.name) && call.number) {
    root.querySelector('#csName').innerHTML =
      `${esc(title)}<div style="font-size:14px;font-weight:400;color:var(--text-3);margin-top:4px">${esc(
        prettyNumber(call.number)
      )}</div>`;
  }

  const connected = call.status === 'connected';
  root.querySelector('#csControls').classList.toggle('pending', !connected);
  root.querySelectorAll('.cc').forEach((b) => {
    b.disabled = !connected;
  });
  root.querySelector('[data-act="mute"]').classList.toggle('active', call.muted);
  root.querySelector('#csMuteIcon').innerHTML = icon(call.muted ? 'micOff' : 'mic', 22);
  root.querySelector('#csMuteLabel').textContent = call.muted ? 'Unmute' : 'Mute';
  root.querySelector('[data-act="hold"]').classList.toggle('active', call.onHold);
  root.querySelector('#csHoldIcon').innerHTML = icon(call.onHold ? 'play' : 'pause', 20);
  root.querySelector('#csHoldLabel').textContent = call.onHold ? 'Resume' : 'Hold';

  const endRow = root.querySelector('#csEndRow');
  const incomingRinging = call.direction === 'in' && call.status === 'ringing';
  endRow.innerHTML = incomingRinging
    ? `<button class="end-btn" id="csDecline" title="Decline">${icon('phoneOff', 26, 2)}</button>
       <button class="end-btn accept" id="csAccept" title="Answer">${icon('phone', 26, 2)}</button>`
    : `<button class="end-btn" id="csEnd" title="End call">${icon('phoneOff', 26, 2)}</button>`;

  endRow.querySelector('#csAccept')?.addEventListener('click', () => phone.answer());
  endRow.querySelector('#csDecline')?.addEventListener('click', () => phone.hangup());
  endRow.querySelector('#csEnd')?.addEventListener('click', () => phone.hangup());
}

/** Escape closes the keypad first, then steps back to the app. Hanging up on
 *  Escape would be far too easy to do by accident. */
export function handleKey(e) {
  if (!root?.classList.contains('on')) return false;

  if (e.key === 'Escape') {
    if (padOpen) togglePad(false);
    else onDismiss?.();
    return true;
  }
  if (padOpen && /^[0-9*#]$/.test(e.key)) {
    playDtmf(e.key);
    if (phone.sendDtmf(e.key)) {
      padSent += e.key;
      root.querySelector('#csPadSent').textContent = padSent;
    }
    return true;
  }
  return false;
}

export function isVisible() {
  return !!root?.classList.contains('on');
}

export function show() {
  root?.classList.add('on');
}
