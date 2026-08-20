/**
 * Bootstrap: routing, the rail, and the wiring between the SIP layer and the
 * views. Everything else lives in its own module; this file's job is to be
 * the only place that knows how the pieces connect.
 */

import { icon } from './icons.js';
import * as store from './store.js';
import { state } from './store.js';
import * as phone from './phone.js';
import { endTone, ringback, ringtone, setVolumes } from './audio.js';
import { duration, esc, sameNumber } from './format.js';

import * as dialer from './ui/dialer.js';
import * as recents from './ui/recents.js';
import * as contacts from './ui/contacts.js';
import * as settings from './ui/settings.js';
import * as callscreen from './ui/callscreen.js';
import { toast } from './ui/toast.js';
import { modal } from './ui/modal.js';

const VIEWS = [
  { id: 'dialer', label: 'Keypad', icon: 'dialpad' },
  { id: 'recents', label: 'Recents', icon: 'clock' },
  { id: 'contacts', label: 'Contacts', icon: 'users' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

let current = 'dialer';
let stopTone = null;
let lastCallStatus = 'idle';

// --------------------------------------------------------------- routing

function buildRail() {
  const rail = document.getElementById('rail');
  rail.innerHTML =
    VIEWS.map(
      (v) => `
      <button class="rail-btn" data-view="${v.id}" title="${v.label}">
        ${icon(v.icon, 21)}
        <span>${v.label}</span>
        ${v.id === 'recents' ? '<i class="badge" id="missedBadge" hidden></i>' : ''}
      </button>`
    ).join('') +
    `<div class="spacer"></div>
     <button class="rail-status" id="railStatus" data-state="idle" title="Connection status">
       <i class="dot"></i><span id="railStatusText">Offline</span>
     </button>`;

  rail.addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-btn');
    if (btn) go(btn.dataset.view);
    if (e.target.closest('#railStatus')) go('settings');
  });
}

function go(id) {
  if (!VIEWS.some((v) => v.id === id)) return;
  if (current === 'settings' && id !== 'settings') settings.onHide();
  current = id;

  document
    .querySelectorAll('.view')
    .forEach((v) => v.classList.toggle('active', v.dataset.view === id));
  document
    .querySelectorAll('.rail-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === id));

  if (id === 'settings') settings.onShow();
  if (id === 'dialer') dialer.refresh();
  if (id === 'recents') {
    // Arriving here is what marks missed calls as seen.
    store.saveSettings({ recentsSeenAt: Date.now() });
    recents.refresh();
    updateMissedBadge();
  }
  if (id === 'contacts') contacts.refresh();
}

function updateMissedBadge() {
  const seenAt = state.settings.recentsSeenAt || 0;
  const n = state.history.filter((h) => h.direction === 'missed' && h.startedAt > seenAt).length;
  const badge = document.getElementById('missedBadge');
  if (!badge) return;
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? '9+' : String(n);
}

// ----------------------------------------------------------------- theme

/** Push the saved levels into the audio layer. Called at startup and
 *  whenever a slider moves. */
export function applyVolumes() {
  setVolumes({ ring: state.settings.ringVolume, tone: state.settings.toneVolume });
}

function applyTheme() {
  const choice = state.settings.theme || 'dark';
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ------------------------------------------------------------ call flow

/** The one way a call gets placed, wherever it was triggered from. */
function placeCall(number, name = '') {
  const err = phone.dial(number, name);
  if (err) {
    toast(err, 'error');
    if (!phone.isRegistered()) go('settings');
    return err;
  }
  callscreen.show();
  return null;
}

function onCallUpdate(call) {
  callscreen.render(call);

  // The popup, when the app is not what the person is looking at. Main owns
  // the decision — it is the only side that knows whether the window is in
  // the tray, minimised or merely behind something. The name is resolved here
  // because contacts live in the renderer.
  if (state.settings.callPopup) {
    const contact = call.number
      ? state.contacts.find((c) => sameNumber(c.number, call.number))
      : null;
    window.dialtone.callToast.sync({
      active: call.active,
      direction: call.direction,
      status: call.status,
      number: call.number,
      name: contact?.name || call.name || '',
      seconds: call.seconds,
      startedAt: call.startedAt,
    });
  }

  // Tones follow the status, and each transition stops whatever was playing
  // before starting anything new — otherwise a fast progress→answer leaves
  // ringback running under a live call.
  const ringingOut = call.status === 'ringing' && call.direction === 'out';
  const ringingIn = call.status === 'ringing' && call.direction === 'in';
  if (call.status !== lastCallStatus) {
    stopTone?.();
    stopTone = null;
    if (ringingOut) stopTone = ringback();
    if (ringingIn) stopTone = ringtone();
    lastCallStatus = call.status;
  }

  // The pill in the titlebar is the only call affordance visible from other
  // views, so it has to track the live duration.
  const pill = document.getElementById('callPill');
  const onCall = call.active && call.status !== 'ended';
  pill.classList.toggle('on', onCall && !callscreen.isVisible());
  if (onCall) {
    document.getElementById('callPillTime').textContent =
      call.status === 'connected' ? duration(call.seconds) : 'Calling';
  }

  window.dialtone.power.keepAwake(onCall);
}

function onCallEnded(summary) {
  stopTone?.();
  stopTone = null;
  lastCallStatus = 'idle';
  endTone();

  // An inbound call that was never answered is a missed call — that
  // distinction is the whole point of the Recents filter.
  const direction =
    summary.direction === 'in' && !summary.answered ? 'missed' : summary.direction;

  store.addCall({
    number: summary.number,
    name: summary.name,
    direction,
    startedAt: summary.startedAt,
    duration: summary.duration,
  });

  if (summary.failed && summary.cause) toast(summary.cause, 'error');
  updateMissedBadge();
  document.getElementById('callPill').classList.remove('on');
  window.dialtone.power.keepAwake(false);
}

function onRegistration({ state: st, detail }) {
  state.registration = { state: st, detail };

  const rail = document.getElementById('railStatus');
  rail.dataset.state = st;
  document.getElementById('railStatusText').textContent =
    { idle: 'Offline', connecting: 'Linking', registered: 'Online', failed: 'Error' }[st] || st;

  settings.refresh();
  dialer.refresh();
  // The tray is the only status indicator visible when the window is hidden.
  window.dialtone.tray.registration({ state: st, detail });
}

function connect() {
  if (!store.isConfigured()) {
    toast('Fill in the server, extension and domain first.', 'error');
    return;
  }
  phone.connect(state.settings);
}

/**
 * Electron reports fingerprints as `sha256/<base64>`. Every tool a person
 * would check against — openssl, a browser's certificate viewer — prints
 * colon-separated uppercase hex. Showing the base64 form makes the
 * comparison impossible, which turns the whole dialog into a checkbox.
 */
function readableFingerprint(raw) {
  const b64 = String(raw || '').replace(/^sha256\//i, '');
  try {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  } catch {
    return b64;
  }
}

/**
 * The certificate prompt.
 *
 * Shows what is actually being trusted rather than asking for a yes to a
 * vague warning: the host, who issued it, and a fingerprint in the same
 * notation openssl prints, so it can be compared. A certificate that CHANGED
 * under a host already trusted is called out separately, because that is the
 * case worth refusing.
 */
function certificateModal(info) {
  const pretty = readableFingerprint(info.fingerprint);
  return modal({
    title: info.changed ? 'Certificate has changed' : 'Untrusted certificate',
    confirmText: 'Trust and connect',
    confirmClass: info.changed ? 'danger' : 'primary',
    body: `
      <p style="margin:0 0 14px;color:var(--text-2);line-height:1.6">
        ${
          info.changed
            ? `The certificate for <b>${esc(info.host)}</b> is not the one trusted before.
               If the server was not just reinstalled or reissued, do not continue.`
            : `<b>${esc(info.host)}</b> presented a certificate this computer cannot verify.
               That is normal for a PBX you run yourself with a self-signed certificate.`
        }
      </p>
      <div class="kv" style="gap:8px 16px">
        <dt>Issued to</dt><dd>${esc(info.subject || '—')}</dd>
        <dt>Issued by</dt><dd>${esc(info.issuer || '—')}</dd>
        <dt>Reason</dt><dd>${esc(info.error || '—')}</dd>
        <dt>SHA-256</dt><dd style="font-family:Consolas,ui-monospace,monospace;font-size:11px;line-height:1.7;word-break:break-all">${esc(
          pretty
        )}</dd>
      </div>
      <p style="margin:14px 0 0;color:var(--text-3);font-size:12px;line-height:1.6">
        Check this fingerprint against the server before trusting it. On the PBX:
        <code>openssl x509 -noout -fingerprint -sha256 -in /etc/freeswitch/tls/wss.pem</code>
      </p>`,
    onConfirm: () => true,
  });
}

let certPromptOpen = false;
function wireCertificatePrompt() {
  window.dialtone.certs.onUntrusted(async (info) => {
    // The socket retries, so this fires repeatedly for one bad certificate.
    if (certPromptOpen) return;
    certPromptOpen = true;
    phone.disconnect();

    const ok = await certificateModal(info);

    certPromptOpen = false;
    if (!ok) {
      toast('Certificate refused — not connected.', 'error');
      return;
    }
    await window.dialtone.certs.trust({ host: info.host, fingerprint: info.fingerprint });
    toast(`Trusted ${info.host}`, 'ok');
    connect();
  });
}

// ------------------------------------------------------------------ boot

async function main() {
  await store.load();
  applyTheme();
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => state.settings.theme === 'system' && applyTheme());

  buildRail();
  applyVolumes();
  phone.attachAudioElement(document.getElementById('remoteAudio'));

  const shared = {
    placeCall,
    connect,
    applyTheme,
    applyVolumes,
    openContact: (id) => {
      go('contacts');
      contacts.select(id);
    },
  };

  dialer.init(document.getElementById('viewDialer'), shared);
  recents.init(document.getElementById('viewRecents'), shared);
  contacts.init(document.getElementById('viewContacts'), shared);
  settings.init(document.getElementById('viewSettings'), shared);
  callscreen.init(document.getElementById('callscreen'), {
    dismiss: () => {
      // Stepping back from the call screen leaves the call up; the pill is
      // what brings it back.
      document.getElementById('callscreen').classList.remove('on');
      onCallUpdate(phone.call);
    },
  });

  phone.on('registration', onRegistration);
  phone.on('call', onCallUpdate);
  phone.on('ended', onCallEnded);

  // The popup's buttons act on the session, which only lives here.
  window.dialtone.callToast.onAnswer(() => phone.answer());
  window.dialtone.callToast.onHangup(() => phone.hangup());

  // Views that show contact names must redraw when contacts change.
  store.subscribe((what) => {
    if (what === 'contacts' || what === 'all') {
      recents.refresh();
      dialer.refresh();
    }
    if (what === 'history' || what === 'all') updateMissedBadge();
  });

  go('dialer');
  updateMissedBadge();
  installPreviewHook();

  if (state.settings.speakerDeviceId) phone.setSpeaker(state.settings.speakerDeviceId);

  if (state.settings.autoConnect && store.isConfigured()) {
    connect();
  } else if (!store.isConfigured()) {
    // First run: there is nothing to dial with, so start where the work is.
    go('settings');
  }

  wireChrome();
  wireCertificatePrompt();
}

/**
 * Development only: render the call screen in a given state.
 *
 * The call screen is the screen that matters most and the only one that
 * cannot be reached without a registered account and a willing far end.
 * Without this it could not be reviewed at all before shipping.
 */
function installPreviewHook() {
  if (!window.dialtone.dev) return;

  // The modules are ES imports and therefore invisible to anything outside
  // this bundle. The smoke test needs to reach them, and only in --dev.
  window.__dialtone = { store, phone, dialer, recents, contacts, settings, go, placeCall, connect };

  // Returns nothing on purpose: executeJavaScript awaits a returned promise,
  // and this one only settles when a button is clicked.
  window.__previewCert = () => {
    certificateModal({
      host: 'pbx.example.com:7443',
      subject: 'pbx.example.com',
      issuer: 'pbx.example.com (self-signed)',
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
      fingerprint: 'sha256/ZrpyigfUEZIazzXP0U/6bNsuUEd52aRuY2THw42ajnQ=',
      changed: false,
    });
  };

  window.__previewCall = (status = 'connected', direction = 'out') => {
    callscreen.render({
      active: true,
      direction,
      number: '1001',
      name: '',
      status,
      muted: false,
      onHold: false,
      seconds: 137,
      startedAt: Date.now() - 137000,
      connectedAt: Date.now() - 137000,
      lastError: '',
    });
  };
}

function wireChrome() {
  const w = window.dialtone.window;
  document.getElementById('winMin').onclick = () => w.minimize();
  document.getElementById('winMax').onclick = () => w.toggleMaximize();
  document.getElementById('winClose').onclick = () => w.close();
  w.onState(({ maximized }) => {
    // Two overlapping squares when maximised, one when not — the Windows
    // convention, and the only cue that the button will restore.
    document.getElementById('maxIcon').innerHTML = maximized
      ? '<rect x="1.2" y="3.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.4 3V1.2h7.4v7.4H9" fill="none" stroke="currentColor" stroke-width="1.2"/>'
      : '<rect x="1.2" y="1.2" width="9.6" height="9.6" fill="none" stroke="currentColor" stroke-width="1.2"/>';
  });

  document.getElementById('callPill').onclick = (e) => {
    if (e.target.closest('#callPillEnd')) {
      phone.hangup();
      return;
    }
    callscreen.show();
    onCallUpdate(phone.call);
  };

  document.addEventListener('keydown', (e) => {
    if (callscreen.handleKey(e)) return;
    if (document.getElementById('scrim').classList.contains('on')) return;

    // Ctrl+1..4 jumps between views, like tabs everywhere else.
    if (e.ctrlKey && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      go(VIEWS[Number(e.key) - 1].id);
      return;
    }
    if (dialer.handleGlobalKey(e)) e.preventDefault();
  });
}

main().catch((err) => {
  console.error(err);
  toast(`Failed to start: ${err.message}`, 'error');
});
