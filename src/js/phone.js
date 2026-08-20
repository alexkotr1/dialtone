/**
 * The SIP layer: registration, one call at a time, and the audio plumbing.
 *
 * Wraps JsSIP so the rest of the app never touches a session object. Views
 * ask this module to dial, answer, mute, hold or hang up, and re-render from
 * the snapshot it publishes. That boundary is what keeps call state in one
 * place rather than smeared across four views.
 *
 * Deliberately single-call. A softphone that can juggle three lines needs a
 * call-list UI, transfer semantics and a hold policy; this one is a desk
 * phone, and pretending otherwise would be a worse version of both.
 */

import { normalise } from './format.js';

const JsSIP = window.JsSIP;

/** JsSIP logs every SIP message at debug level. Useful when a registration
 *  will not come up, noise the rest of the time. */
JsSIP.debug.disable();
export function setSipLogging(on) {
  if (on) JsSIP.debug.enable('JsSIP:*');
  else JsSIP.debug.disable();
}

const handlers = new Map();

/** @param {'registration'|'call'|'error'} event */
export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn);
}

function fire(event, payload) {
  for (const fn of handlers.get(event) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`listener for "${event}" threw`, err);
    }
  }
}

let ua = null;
let session = null;
let audioEl = null;
let settings = {};
let durationTimer = null;

/**
 * How long a connection attempt may sit in "connecting" before we call it.
 *
 * There has to be a deadline on our side. A WebSocket to a host that drops
 * packets — the wrong IP, a closed port, a firewall — does not fail fast; the
 * OS sits in TCP connect for the better part of a minute, and JsSIP then
 * retries, so "connecting" can persist indefinitely with nothing wrong on
 * screen. Twelve seconds is well past a working LAN or WAN registration and
 * well short of anyone's patience.
 */
const CONNECT_DEADLINE_MS = 12000;

let watchdog = null;
/** Set once the watchdog has fired, so later retry churn is reported as
 *  retrying rather than as a fresh, hopeful first attempt. */
let attemptFailed = false;

/** The single source of truth for what the call screen shows. */
export const call = {
  active: false,
  direction: null, // 'in' | 'out'
  number: '',
  name: '',
  /** 'calling' | 'ringing' | 'connected' | 'ended' */
  status: 'idle',
  muted: false,
  onHold: false,
  startedAt: 0,
  connectedAt: 0,
  seconds: 0,
  lastError: '',
};

function publish() {
  fire('call', { ...call });
}

function resetCall() {
  clearInterval(durationTimer);
  durationTimer = null;
  Object.assign(call, {
    active: false,
    direction: null,
    number: '',
    name: '',
    status: 'idle',
    muted: false,
    onHold: false,
    startedAt: 0,
    connectedAt: 0,
    seconds: 0,
  });
}

export function attachAudioElement(el) {
  audioEl = el;
}

/** Route call audio to a chosen output. Only Chromium implements setSinkId,
 *  which is exactly where this runs. */
export async function setSpeaker(deviceId) {
  if (!audioEl || typeof audioEl.setSinkId !== 'function') return false;
  try {
    await audioEl.setSinkId(deviceId || '');
    return true;
  } catch {
    return false;
  }
}

function iceServers() {
  const stun = (settings.stun || '').trim();
  return stun ? [{ urls: stun.split(/[\s,]+/).filter(Boolean) }] : [];
}

function mediaConstraints() {
  const mic = settings.micDeviceId;
  return { audio: mic ? { deviceId: { exact: mic } } : true, video: false };
}

/** Wire the far end's audio into the page. Both events are handled because
 *  which one arrives first differs between an outgoing call (peerconnection
 *  fires before the answer) and an incoming one (the connection may already
 *  exist by the time we answer). */
function attachRemoteAudio(s) {
  const bind = (pc) => {
    if (!pc) return;
    const play = (stream) => {
      if (audioEl && stream) audioEl.srcObject = stream;
    };
    pc.addEventListener('track', (ev) => play(ev.streams[0]));
    // Covers the case where the track arrived before this listener did.
    const existing = pc.getReceivers?.().find((r) => r.track && r.track.kind === 'audio');
    if (existing) {
      const stream = new MediaStream([existing.track]);
      play(stream);
    }
  };
  s.on('peerconnection', (e) => bind(e.peerconnection));
  bind(s.connection);
}

function startDurationTimer() {
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    if (call.connectedAt) {
      call.seconds = Math.floor((Date.now() - call.connectedAt) / 1000);
      publish();
    }
  }, 1000);
}

/** Translate SIP's vocabulary into something worth showing a person.
 *  "Cause: 486" is not an error message. */
function humanCause(cause) {
  const map = {
    'Busy': 'Busy',
    'Rejected': 'Call declined',
    'Redirected': 'Redirected',
    'Unavailable': 'Unavailable',
    'Not Found': 'Number not found',
    'Address Incomplete': 'Incomplete number',
    'Incompatible SDP': 'No common audio codec',
    'Missing SDP': 'No audio negotiated',
    'Authentication Error': 'Authentication failed',
    'Request Timeout': 'No answer',
    'SIP Failure Code': 'Rejected by server',
    'Internal Error': 'Internal error',
    'Bye': 'Call ended',
    'Canceled': 'Cancelled',
    'No Answer': 'No answer',
    'Expires': 'No answer',
    'User Denied Media Access': 'Microphone access denied',
    'WebRTC Error': 'Audio device error',
    'Connection Error': 'Cannot reach the server',
    'RTP Timeout': 'Audio stopped',
  };
  return map[cause] || String(cause || 'Call ended');
}

// --- registration ---------------------------------------------------------

function setRegistration(state, detail = '') {
  fire('registration', { state, detail });
}

/** Arm the deadline for the current attempt. */
function armWatchdog(wsUrl) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (isRegistered()) return;
    attemptFailed = true;
    setRegistration(
      'failed',
      `No response from ${wsUrl}. Check the host and port — this must be ` +
        `FreeSWITCH's WebSocket port (ws-binding / wss-binding), not SIP 5060. ` +
        `A TLS certificate the app does not trust fails the same way. Still retrying.`
    );
  }, CONNECT_DEADLINE_MS);
}

function disarmWatchdog() {
  clearTimeout(watchdog);
  watchdog = null;
}

/**
 * Connect and register. Safe to call repeatedly — it tears down any previous
 * UA first, which is what makes "Save & Connect" in Settings idempotent.
 */
export function connect(nextSettings) {
  settings = { ...nextSettings };
  disconnect();

  const wsUrl = (settings.wsUrl || '').trim();
  const domain = (settings.domain || '').trim();
  const username = (settings.username || '').trim();

  if (!wsUrl || !domain || !username) {
    setRegistration('failed', 'Server, domain and extension are all required.');
    return false;
  }
  if (!/^wss?:\/\//i.test(wsUrl)) {
    setRegistration('failed', 'The server URL must start with wss:// or ws://');
    return false;
  }

  attemptFailed = false;
  setRegistration('connecting', `Connecting to ${wsUrl}`);
  armWatchdog(wsUrl);

  try {
    const socket = new JsSIP.WebSocketInterface(wsUrl);
    ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${username}@${domain}`,
      password: settings.password || '',
      display_name: settings.displayName || username,
      register: true,
      // FreeSWITCH and JsSIP disagree often enough about session timers that
      // leaving them on produces mid-call re-INVITE churn for no benefit on
      // a single-call desk phone.
      session_timers: false,
      user_agent: 'Dialtone',
    });
  } catch (err) {
    setRegistration('failed', err?.message || 'Could not create the SIP client.');
    return false;
  }

  ua.on('connecting', () =>
    setRegistration('connecting', attemptFailed ? 'Retrying…' : 'Opening WebSocket…')
  );
  ua.on('connected', () => setRegistration('connecting', 'Connected — registering…'));
  ua.on('disconnected', () => {
    // Not reported as failed here. JsSIP fires this on every retry, so doing
    // so would flap the status between failed and connecting once a second
    // and bury whatever the real cause was. The watchdog owns that verdict.
    if (!attemptFailed) setRegistration('connecting', 'Reconnecting…');
  });
  ua.on('registered', () => {
    disarmWatchdog();
    attemptFailed = false;
    setRegistration('registered', `${username}@${domain}`);
  });
  ua.on('unregistered', () => setRegistration('idle', 'Not registered'));
  ua.on('registrationFailed', (e) => {
    // A rejection is a definite answer from a server that is reachable, so it
    // supersedes the deadline entirely.
    disarmWatchdog();
    attemptFailed = true;
    const cause = e?.cause || 'Registration rejected';
    setRegistration(
      'failed',
      cause === 'Authentication Error'
        ? 'Authentication failed — check the extension and password.'
        : humanCause(cause)
    );
  });

  ua.on('newRTCSession', (e) => {
    const s = e.session;

    // One line only: anything arriving while a call is up gets a busy signal
    // rather than silently stacking behind the current call.
    if (session) {
      if (e.originator === 'remote') s.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
      return;
    }

    session = s;
    attachRemoteAudio(s);
    wireSession(s, e.originator === 'remote' ? 'in' : 'out');
  });

  ua.start();
  return true;
}

export function disconnect() {
  disarmWatchdog();
  attemptFailed = false;
  if (session) {
    try {
      session.terminate();
    } catch {
      /* already gone */
    }
    session = null;
  }
  resetCall();
  publish();
  if (ua) {
    try {
      ua.stop();
    } catch {
      /* already stopped */
    }
    ua = null;
  }
  setRegistration('idle', 'Not connected');
}

export function isRegistered() {
  return !!ua && ua.isRegistered();
}

// --- call lifecycle -------------------------------------------------------

function wireSession(s, direction) {
  call.active = true;
  call.direction = direction;
  call.startedAt = Date.now();
  call.connectedAt = 0;
  call.seconds = 0;
  call.muted = false;
  call.onHold = false;
  call.lastError = '';

  const remote = s.remote_identity || {};
  call.number = normalise(remote.uri?.user || '');
  call.name = (remote.display_name || '').trim();
  call.status = direction === 'in' ? 'ringing' : 'calling';
  publish();

  // 180/183 from the far end: it is ringing there.
  s.on('progress', () => {
    if (direction === 'out') {
      call.status = 'ringing';
      publish();
    }
  });

  s.on('accepted', () => {
    call.status = 'connected';
    if (!call.connectedAt) call.connectedAt = Date.now();
    startDurationTimer();
    publish();
  });

  s.on('confirmed', () => {
    call.status = 'connected';
    if (!call.connectedAt) call.connectedAt = Date.now();
    startDurationTimer();
    publish();
  });

  s.on('hold', () => {
    call.onHold = true;
    publish();
  });
  s.on('unhold', () => {
    call.onHold = false;
    publish();
  });
  s.on('muted', () => {
    call.muted = true;
    publish();
  });
  s.on('unmuted', () => {
    call.muted = false;
    publish();
  });

  const finish = (cause, failed) => {
    if (session !== s) return;
    const summary = {
      direction,
      number: call.number,
      name: call.name,
      startedAt: call.startedAt,
      // Ring time is not talk time. An unanswered call logs zero seconds,
      // which is what makes "missed" distinguishable in the log.
      duration: call.connectedAt ? Math.floor((Date.now() - call.connectedAt) / 1000) : 0,
      answered: !!call.connectedAt,
      cause: humanCause(cause),
      failed: !!failed,
    };
    session = null;
    call.status = 'ended';
    call.lastError = failed ? summary.cause : '';
    publish();
    resetCall();
    fire('ended', summary);
    publish();
  };

  s.on('ended', (e) => finish(e?.cause, false));
  s.on('failed', (e) => finish(e?.cause, true));
}

/** Dial. Returns an error string, or null when the attempt started. */
export function dial(number, name = '') {
  const target = normalise(number);
  if (!target) return 'No number to dial.';
  if (!ua || !ua.isRegistered()) return 'Not registered — check Settings.';
  if (session) return 'Already on a call.';

  try {
    const s = ua.call(`sip:${target}@${(settings.domain || '').trim()}`, {
      mediaConstraints: mediaConstraints(),
      pcConfig: { iceServers: iceServers() },
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    });
    // ua.call fires newRTCSession synchronously, which is where the session
    // is adopted; this only fills in the name we already know from contacts.
    if (name) {
      call.name = name;
      publish();
    }
    return s ? null : 'Could not start the call.';
  } catch (err) {
    return err?.message || 'Could not start the call.';
  }
}

export function answer() {
  if (!session) return;
  session.answer({
    mediaConstraints: mediaConstraints(),
    pcConfig: { iceServers: iceServers() },
  });
}

export function hangup() {
  if (!session) return;
  try {
    // Declining a call that was never answered is a rejection, not a BYE.
    if (call.direction === 'in' && call.status === 'ringing') {
      session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
    } else {
      session.terminate();
    }
  } catch {
    /* the session ended underneath us; the 'ended' handler already ran */
  }
}

export function toggleMute() {
  if (!session) return;
  if (session.isMuted().audio) session.unmute({ audio: true });
  else session.mute({ audio: true });
}

export function toggleHold() {
  if (!session || call.status !== 'connected') return;
  if (session.isOnHold().local) session.unhold();
  else session.hold();
}

export function sendDtmf(key) {
  if (!session || call.status !== 'connected') return false;
  try {
    session.sendDTMF(key);
    return true;
  } catch {
    return false;
  }
}
