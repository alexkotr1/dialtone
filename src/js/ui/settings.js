import { icon } from '../icons.js';
import { esc } from '../format.js';
import { state, saveSettings, isConfigured, applyImport } from '../store.js';
import * as phone from '../phone.js';
import { meterMic, playDtmf, ringtone } from '../audio.js';
import { toast } from './toast.js';
import { modal } from './modal.js';

let root = null;
let actions = {};
let stopMeter = null;
let built = false;
let showRingVol = null;
let showToneVol = null;

const STATUS_TEXT = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  registered: 'Registered',
  failed: 'Not connected',
};

export function init(el, api) {
  root = el;
  actions = api;
  build();
}

function build() {
  const s = state.settings;
  root.innerHTML = `
    <div class="settings-scroll">
      <div class="settings-inner">
        <header>
          <h1>Settings</h1>
          <p>Connect Dialtone to your FreeSWITCH server.</p>
        </header>

        <div class="card">
          <header>
            <div>
              <h3>SIP account</h3>
              <p>Credentials for the extension this app registers as.</p>
            </div>
          </header>
          <div class="card-body">
            <div class="status-line" id="setStatus" data-state="idle">
              <i class="dot"></i>
              <div class="txt"><b id="setStatusTitle">Not connected</b><span id="setStatusDetail"></span></div>
            </div>

            <div class="field">
              <label for="setWs">WebSocket server</label>
              <input class="input" id="setWs" spellcheck="false" placeholder="wss://pbx.example.com:7443"
                     value="${esc(s.wsUrl)}" />
              <div class="help">
                FreeSWITCH's SIP-over-WebSocket port — <code>wss://</code> for TLS (usually 7443),
                <code>ws://</code> for plaintext (usually 5066). This is not the plain SIP port 5060.
              </div>
            </div>

            <div class="grid-2">
              <div class="field">
                <label for="setExt">Extension</label>
                <input class="input" id="setExt" spellcheck="false" placeholder="1001" value="${esc(
                  s.username
                )}" />
              </div>
              <div class="field">
                <label for="setDomain">SIP domain</label>
                <input class="input" id="setDomain" spellcheck="false" placeholder="pbx.example.com"
                       value="${esc(s.domain)}" />
              </div>
            </div>

            <div class="grid-2">
              <div class="field">
                <label for="setPass">Password</label>
                <div class="input-group">
                  <input class="input" id="setPass" type="password" autocomplete="off"
                         placeholder="••••••••" value="${esc(s.password)}" />
                  <button class="adorn" id="setPassToggle" title="Show password" type="button">
                    ${icon('eye', 16)}
                  </button>
                </div>
              </div>
              <div class="field">
                <label for="setName">Display name</label>
                <input class="input" id="setName" placeholder="Alex" value="${esc(s.displayName)}" />
              </div>
            </div>

            <div class="field">
              <label for="setStun">STUN server <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
              <input class="input" id="setStun" spellcheck="false" value="${esc(s.stun)}"
                     placeholder="stun:stun.l.google.com:19302" />
              <div class="help">
                Only needed when the media path crosses a NAT. On a LAN PBX, leaving this empty
                connects faster.
              </div>
            </div>

            <label class="switch" id="setAuto">
              <div>
                <div style="font-size:13px;font-weight:600">Connect on startup</div>
                <div class="help">Register automatically when Dialtone opens.</div>
              </div>
              <span class="track"><span class="thumb"></span></span>
            </label>

            <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
              <button class="btn ghost" id="setDisconnect">Disconnect</button>
              <button class="btn primary" id="setConnect">${icon('link', 15)}Save &amp; connect</button>
            </div>

            <div id="setSecurityNote"></div>
          </div>
        </div>

        <div class="card">
          <header>
            <div>
              <h3>Audio</h3>
              <p>Which devices calls use.</p>
            </div>
            <button class="btn ghost" id="setRefreshDevices" title="Rescan devices">
              ${icon('refresh', 15)}
            </button>
          </header>
          <div class="card-body">
            <div class="field">
              <label for="setMic">Microphone</label>
              <select class="input" id="setMic"></select>
              <div class="meter" title="Input level"><i id="setMeter"></i></div>
              <div class="help" id="setMicHelp">Speak — the bar should move.</div>
            </div>
            <div class="field">
              <label for="setSpeaker">Speaker</label>
              <select class="input" id="setSpeaker"></select>
            </div>

            <div class="field">
              <label for="setRingVol">Ringtone <span class="vol-val" id="setRingVolVal"></span></label>
              <input type="range" class="slider" id="setRingVol" min="0" max="100" step="1" />
              <div class="help">
                The incoming ring, and the ringing tone you hear on outgoing calls.
                Release the slider to hear it.
              </div>
            </div>

            <div class="field">
              <label for="setToneVol">Keypad tones <span class="vol-val" id="setToneVolVal"></span></label>
              <input type="range" class="slider" id="setToneVol" min="0" max="100" step="1" />
              <div class="help">
                Dialpad key tones and the note that plays when a call ends.
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <header>
            <div>
              <h3>Behaviour</h3>
              <p>What Dialtone does when you are not looking at it.</p>
            </div>
          </header>
          <div class="card-body">
            <label class="switch" id="setStartup">
              <div>
                <div style="font-size:13px;font-weight:600">Start with Windows</div>
                <div class="help">Launches at login, straight into the tray with no window.</div>
              </div>
              <span class="track"><span class="thumb"></span></span>
            </label>

            <label class="switch" id="setKeepTray">
              <div>
                <div style="font-size:13px;font-weight:600">Keep running in the tray when closed</div>
                <div class="help">
                  Closing the window hides it instead of quitting, so calls still arrive.
                  Quit from the tray icon.
                </div>
              </div>
              <span class="track"><span class="thumb"></span></span>
            </label>

            <label class="switch" id="setCallPopup">
              <div>
                <div style="font-size:13px;font-weight:600">Show a call popup</div>
                <div class="help">
                  When a call arrives and Dialtone is not in front, a small window slides in
                  at the bottom-right with Answer and Decline. Nothing is pulled to the
                  foreground.
                </div>
              </div>
              <span class="track"><span class="thumb"></span></span>
            </label>
          </div>
        </div>

        <div class="card">
          <header>
            <div>
              <h3>Backup</h3>
              <p>Move your account, contacts and call history to another machine.</p>
            </div>
          </header>
          <div class="card-body">
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn" id="setExport">${icon('folder', 15)}Export to a file</button>
              <button class="btn" id="setImport">${icon('refresh', 15)}Import from a file</button>
            </div>
            <label class="switch" id="setExportPassword">
              <div>
                <div style="font-size:13px;font-weight:600">Include the SIP password in exports</div>
                <div class="help">
                  Off by default. The password cannot be re-encrypted for another machine, so
                  including it means it sits in the file as readable text.
                </div>
              </div>
              <span class="track"><span class="thumb"></span></span>
            </label>
          </div>
        </div>

        <div class="card">
          <header><div><h3>Appearance</h3><p>How Dialtone looks.</p></div></header>
          <div class="card-body">
            <div class="theme-picker" id="setTheme">
              <button class="theme-opt" data-theme="dark"><span class="swatch dark"></span>Dark</button>
              <button class="theme-opt" data-theme="light"><span class="swatch light"></span>Light</button>
              <button class="theme-opt" data-theme="system"><span class="swatch system"></span>System</button>
            </div>
          </div>
        </div>

        <div class="card">
          <header><div><h3>About</h3></div></header>
          <div class="card-body">
            <dl class="kv" id="setAbout"></dl>
            <div style="display:flex;gap:10px">
              <button class="btn" id="setOpenData">${icon('folder', 15)}Open data folder</button>
              <button class="btn ghost" id="setSipLog">Enable SIP logging</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  built = true;
  wire();
  refresh();
  loadDevices();
  loadAbout();
}

function fields() {
  return {
    wsUrl: root.querySelector('#setWs').value.trim(),
    username: root.querySelector('#setExt').value.trim(),
    domain: root.querySelector('#setDomain').value.trim(),
    password: root.querySelector('#setPass').value,
    displayName: root.querySelector('#setName').value.trim(),
    stun: root.querySelector('#setStun').value.trim(),
  };
}

function wire() {
  // Persist as you type so a half-filled form survives a restart, but do not
  // reconnect — that only happens on the button.
  for (const id of ['#setWs', '#setExt', '#setDomain', '#setPass', '#setName', '#setStun']) {
    root.querySelector(id).addEventListener('input', () => {
      saveSettings(fields());
      updateConnectButton();
    });
  }

  const pass = root.querySelector('#setPass');
  root.querySelector('#setPassToggle').onclick = (e) => {
    e.preventDefault();
    const showing = pass.type === 'text';
    pass.type = showing ? 'password' : 'text';
    e.currentTarget.innerHTML = icon(showing ? 'eye' : 'eyeOff', 16);
    e.currentTarget.title = showing ? 'Show password' : 'Hide password';
  };

  const auto = root.querySelector('#setAuto');
  auto.onclick = () => {
    const next = !state.settings.autoConnect;
    saveSettings({ autoConnect: next });
    auto.classList.toggle('on', next);
  };

  root.querySelector('#setConnect').onclick = async () => {
    await saveSettings(fields());
    actions.connect();
  };
  root.querySelector('#setDisconnect').onclick = () => {
    phone.disconnect();
    toast('Disconnected');
  };

  root.querySelector('#setTheme').addEventListener('click', (e) => {
    const opt = e.target.closest('.theme-opt');
    if (!opt) return;
    saveSettings({ theme: opt.dataset.theme });
    actions.applyTheme();
    refresh();
  });

  root.querySelector('#setMic').addEventListener('change', (e) => {
    saveSettings({ micDeviceId: e.target.value });
    startMeter();
  });
  root.querySelector('#setSpeaker').addEventListener('change', async (e) => {
    saveSettings({ speakerDeviceId: e.target.value });
    const ok = await phone.setSpeaker(e.target.value);
    if (!ok) toast('This output device could not be selected.', 'error');
  });
  root.querySelector('#setRefreshDevices').onclick = () => loadDevices(true);

  // --- volumes -----------------------------------------------------------
  //
  // Applied live as the slider moves, so the preview on release is played at
  // the level just chosen rather than the previously saved one.
  const wireVolume = (id, key, preview) => {
    const el = root.querySelector(id);
    const label = root.querySelector(`${id}Val`);
    const show = () => {
      label.textContent = `${el.value}%`;
    };
    el.oninput = () => {
      show();
      saveSettings({ [key]: Number(el.value) / 100 });
      actions.applyVolumes();
    };
    // 'change' fires once on release, unlike 'input'; a preview on every
    // pixel of drag would be unbearable.
    el.onchange = () => preview();
    return show;
  };

  let stopPreview = null;
  const previewRing = () => {
    stopPreview?.();
    stopPreview = ringtone();
    // Long enough to hear the motif, short enough not to become the thing you
    // are trying to escape.
    setTimeout(() => {
      stopPreview?.();
      stopPreview = null;
    }, 1800);
  };

  showRingVol = wireVolume('#setRingVol', 'ringVolume', previewRing);
  showToneVol = wireVolume('#setToneVol', 'toneVolume', () => playDtmf('5'));

  // --- behaviour ---------------------------------------------------------

  const startup = root.querySelector('#setStartup');
  startup.onclick = async () => {
    // The OS is the source of truth for the login item, not our settings
    // file: it can be turned off in Task Manager behind our back, so the
    // toggle reflects whatever the OS reports back after the write.
    const next = !startup.classList.contains('on');
    const actual = await window.dialtone.startup.set(next);
    startup.classList.toggle('on', actual);
    if (next && !actual) toast('Windows refused the startup entry.', 'error');
    else toast(actual ? 'Dialtone will start with Windows' : 'Startup entry removed', 'ok');
  };

  const keepTray = root.querySelector('#setKeepTray');
  keepTray.onclick = () => {
    const next = !state.settings.keepInTray;
    saveSettings({ keepInTray: next });
    keepTray.classList.toggle('on', next);
  };

  const callPopup = root.querySelector('#setCallPopup');
  callPopup.onclick = () => {
    const next = !state.settings.callPopup;
    saveSettings({ callPopup: next });
    callPopup.classList.toggle('on', next);
  };

  // --- backup ------------------------------------------------------------

  const exportPw = root.querySelector('#setExportPassword');
  let includePassword = false;
  exportPw.onclick = () => {
    includePassword = !includePassword;
    exportPw.classList.toggle('on', includePassword);
  };

  root.querySelector('#setExport').onclick = async () => {
    const r = await window.dialtone.config.export({ includePassword });
    if (r.canceled) return;
    if (!r.ok) {
      toast(r.error || 'Export failed.', 'error');
      return;
    }
    toast(
      `Exported ${r.counts.contacts} contacts and ${r.counts.history} calls` +
        (includePassword ? ' (password included)' : ''),
      'ok'
    );
  };

  root.querySelector('#setImport').onclick = () => importConfig();

  root.querySelector('#setOpenData').onclick = () => window.dialtone.app.openDataDir();

  let logging = false;
  const logBtn = root.querySelector('#setSipLog');
  logBtn.onclick = () => {
    logging = !logging;
    phone.setSipLogging(logging);
    logBtn.textContent = logging ? 'Disable SIP logging' : 'Enable SIP logging';
    toast(
      logging ? 'SIP messages now logged to the developer console' : 'SIP logging off',
      logging ? 'ok' : ''
    );
  };
}

/**
 * Import, with the choice of what to do about what is already here.
 *
 * Shows the counts before doing anything: an import that silently replaces a
 * contact list is the kind of thing people only notice a week later.
 */
async function importConfig() {
  const r = await window.dialtone.config.import();
  if (r.canceled) return;
  if (!r.ok) {
    toast(r.error || 'Import failed.', 'error');
    return;
  }

  const b = r.bundle;
  const when = b.exportedAt ? new Date(b.exportedAt).toLocaleString() : 'an unknown date';
  const mode = await modal({
    title: 'Import configuration',
    confirmText: 'Merge',
    cancelText: 'Cancel',
    body: `
      <p style="margin:0 0 14px;color:var(--text-2);line-height:1.6">
        Exported ${esc(when)}.
      </p>
      <dl class="kv" style="gap:8px 18px">
        <dt>Contacts</dt><dd>${b.contacts.length}</dd>
        <dt>Call history</dt><dd>${b.history.length}</dd>
        <dt>Account</dt><dd>${esc(b.settings.username || '(none)')}@${esc(
          b.settings.domain || '(none)'
        )}</dd>
        <dt>Password</dt><dd>${b.passwordIncluded ? 'included' : 'not included - keeping the current one'}</dd>
      </dl>
      <p style="margin:14px 0 0;color:var(--text-3);font-size:12px;line-height:1.6">
        <b>Merge</b> keeps what you have and adds only what is new.
        <b>Replace</b> discards your current contacts and history first.
        Connection settings are replaced either way.
      </p>
      <label class="switch" id="impReplace" style="margin-top:14px">
        <div><div style="font-size:13px;font-weight:600">Replace instead of merging</div></div>
        <span class="track"><span class="thumb"></span></span>
      </label>`,
    onMount: (rootEl) => {
      const sw = rootEl.querySelector('#impReplace');
      const btn = rootEl.querySelector('[data-act="ok"]');
      sw.onclick = () => {
        const on = !sw.classList.contains('on');
        sw.classList.toggle('on', on);
        btn.textContent = on ? 'Replace' : 'Merge';
        btn.classList.toggle('danger', on);
        btn.classList.toggle('primary', !on);
      };
    },
    onConfirm: (rootEl) =>
      rootEl.querySelector('#impReplace').classList.contains('on') ? 'replace' : 'merge',
  });

  if (!mode) return;
  const added = await applyImport(b, mode);
  build();
  toast(
    mode === 'replace'
      ? `Replaced with ${added.contacts} contacts and ${added.history} calls`
      : `Added ${added.contacts} contacts and ${added.history} calls`,
    'ok'
  );
}

function updateConnectButton() {
  root.querySelector('#setConnect').disabled = !isConfigured(fields());
}

/** Only the parts that change — never the inputs, which would fight typing. */
export function refresh() {
  if (!root || !built) return;
  const { state: st, detail } = state.registration;

  const line = root.querySelector('#setStatus');
  line.dataset.state = st;
  root.querySelector('#setStatusTitle').textContent = STATUS_TEXT[st] || st;
  root.querySelector('#setStatusDetail').textContent = detail || '';

  root.querySelector('#setAuto').classList.toggle('on', !!state.settings.autoConnect);
  root.querySelector('#setKeepTray').classList.toggle('on', !!state.settings.keepInTray);
  root.querySelector('#setCallPopup').classList.toggle('on', !!state.settings.callPopup);

  const ring = root.querySelector('#setRingVol');
  const tone = root.querySelector('#setToneVol');
  if (ring && document.activeElement !== ring) {
    ring.value = String(Math.round((state.settings.ringVolume ?? 0.6) * 100));
    showRingVol?.();
  }
  if (tone && document.activeElement !== tone) {
    tone.value = String(Math.round((state.settings.toneVolume ?? 0.6) * 100));
    showToneVol?.();
  }
  // Asked of the OS rather than read from our settings: the login item can be
  // removed in Task Manager without us hearing about it, and a toggle that
  // shows "on" for something Windows has disabled is worse than no toggle.
  window.dialtone.startup
    .get()
    .then((on) => root.querySelector('#setStartup')?.classList.toggle('on', on));
  root.querySelector('#setDisconnect').disabled = st === 'idle';
  updateConnectButton();

  root
    .querySelectorAll('.theme-opt')
    .forEach((o) => o.classList.toggle('active', o.dataset.theme === state.settings.theme));

  // Only worth saying when it is bad news; a working keystore needs no note.
  const note = root.querySelector('#setSecurityNote');
  note.innerHTML = state.encryptionAvailable
    ? ''
    : `<div class="help" style="display:flex;gap:7px;color:var(--amber)">
         ${icon('shield', 15)}
         <span>The OS keystore is unavailable, so the password is not being saved.
         You will need to re-enter it each time.</span>
       </div>`;
}

/** Populate the device pickers. Labels are blank until the mic has been
 *  granted once, which is why this reruns after the meter starts. */
async function loadDevices(rescan = false) {
  const micSel = root.querySelector('#setMic');
  const spkSel = root.querySelector('#setSpeaker');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const spks = devices.filter((d) => d.kind === 'audiooutput');

    const opts = (list, current, fallback) =>
      [`<option value="">${fallback}</option>`]
        .concat(
          list.map(
            (d, i) =>
              `<option value="${esc(d.deviceId)}" ${d.deviceId === current ? 'selected' : ''}>${esc(
                d.label || `Device ${i + 1}`
              )}</option>`
          )
        )
        .join('');

    micSel.innerHTML = opts(mics, state.settings.micDeviceId, 'System default');
    spkSel.innerHTML = opts(spks, state.settings.speakerDeviceId, 'System default');
    if (rescan) toast(`${mics.length} microphones, ${spks.length} outputs`, 'ok');
  } catch {
    micSel.innerHTML = '<option value="">System default</option>';
    spkSel.innerHTML = '<option value="">System default</option>';
  }
  startMeter();
}

/** The level bar. Held open only while Settings is the visible view — a
 *  softphone that keeps the microphone hot in the background is exactly the
 *  thing people are right to be suspicious of. */
function startMeter() {
  stopMeter?.();
  stopMeter = null;
  if (!root.classList.contains('active')) return;

  const bar = root.querySelector('#setMeter');
  const help = root.querySelector('#setMicHelp');
  meterMic(state.settings.micDeviceId, (level) => {
    bar.style.width = `${Math.round(level * 100)}%`;
  })
    .then((stop) => {
      stopMeter = stop;
      // Labels only become readable after permission is granted, so refill
      // the pickers once that has happened.
      if (!root.querySelector('#setMic option[value]:not([value=""])')?.textContent?.trim()) {
        navigator.mediaDevices.enumerateDevices().then(() => {});
      }
    })
    .catch((err) => {
      help.textContent =
        err?.name === 'NotAllowedError'
          ? 'Microphone access was denied — calls will have no audio.'
          : 'No microphone available.';
      help.style.color = 'var(--red)';
    });
}

/** Called by the router so the mic is only open on this screen. */
export function onShow() {
  startMeter();
}
export function onHide() {
  stopMeter?.();
  stopMeter = null;
}

async function loadAbout() {
  const info = await window.dialtone.app.info();
  root.querySelector('#setAbout').innerHTML = `
    <dt>Version</dt><dd>${esc(info.version)}</dd>
    <dt>Electron</dt><dd>${esc(info.electron)} · Chromium ${esc(info.chrome)}</dd>
    <dt>Data</dt><dd>${esc(info.dataDir)}</dd>`;
}
