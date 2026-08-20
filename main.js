/**
 * Electron main process.
 *
 * Owns three things the renderer is not allowed to touch directly: the window
 * (frameless, so the chrome is ours to draw), the settings/contacts/history
 * files on disk, and the SIP password — which goes through safeStorage rather
 * than into the JSON with everything else.
 */

'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEV = process.argv.includes('--dev');

/**
 * Development only: `--shot <file>` renders the window to a PNG and quits.
 *
 * Exists so the UI can be reviewed without screenshotting the whole desktop,
 * which captures whatever else the person has open. It photographs the app's
 * own surface and nothing else.
 *
 * Supports `--route <view>` to open a given screen first, and `--seed` to
 * fill the app with obviously-fake sample data, so list views can be looked
 * at without inventing real contacts.
 */
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const ROUTE = (() => {
  const i = process.argv.indexOf('--route');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const SEED = process.argv.includes('--seed');
const FORCE_THEME = (() => {
  const i = process.argv.indexOf('--theme');
  return i >= 0 ? process.argv[i + 1] : null;
})();
/** Launched by the login item: come up in the tray with no window. */
const START_IN_TRAY = process.argv.includes('--tray');

/** Dev only: show the call popup and stay running, so its z-order can be
 *  inspected against other windows without placing a call for each attempt. */
const TOAST_DEMO = process.argv.includes('--toast-demo');

const SELFTEST = (() => {
  const i = process.argv.indexOf('--selftest');
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'test/smoke.js';
})();
/** Extra CSS selector to click after routing, for shots of a populated
 *  detail pane — which is otherwise unreachable without interaction. */
const CLICK = (() => {
  const i = process.argv.indexOf('--click');
  return i >= 0 ? process.argv[i + 1] : null;
})();
/** Scroll a selector into view before the shutter — for screenshots of
 *  anything below the fold on a long settings page. */
const SCROLL = (() => {
  const i = process.argv.indexOf('--scroll');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** Where state lives. One file per concern so a corrupt history can't take
 *  the account settings down with it. */
const paths = () => ({
  settings: path.join(app.getPath('userData'), 'settings.json'),
  contacts: path.join(app.getPath('userData'), 'contacts.json'),
  history: path.join(app.getPath('userData'), 'history.json'),
});

/** Read JSON, tolerating every way a file can be missing or broken.
 *  A softphone that refuses to start because its call log got truncated is
 *  worse than one that starts with an empty call log. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write atomically: a half-written contacts file is data loss, and rename
 *  is the only step here that is atomic. */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// --- the SIP password -----------------------------------------------------
//
// Kept out of settings.json and encrypted with the OS keystore (DPAPI on
// Windows) so it is not sitting in plaintext next to the extension number.
// safeStorage can be unavailable — a fresh profile, a locked keyring — and
// the honest failure there is to store nothing and say so, not to silently
// fall back to plaintext, which would make the padlock a lie.

const SECRET_FILE = () => path.join(app.getPath('userData'), 'credentials.bin');

function savePassword(plain) {
  if (!plain) {
    fs.rmSync(SECRET_FILE(), { force: true });
    return { ok: true, encrypted: false };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, encrypted: false, error: 'OS keystore unavailable' };
  }
  fs.writeFileSync(SECRET_FILE(), safeStorage.encryptString(plain));
  return { ok: true, encrypted: true };
}

function loadPassword() {
  try {
    return safeStorage.decryptString(fs.readFileSync(SECRET_FILE()));
  } catch {
    return '';
  }
}

// --- TLS for self-hosted PBXes -------------------------------------------
//
// A self-signed or private-CA certificate is the normal case for a PBX you
// run yourself, and Chromium rejects it with no way to say otherwise: the
// WebSocket simply never opens, which from inside the app is indistinguishable
// from a wrong port. Ignoring certificate errors wholesale would fix that and
// throw away the protection at the same time.
//
// So: refuse by default, show the person the host and the SHA-256 fingerprint,
// and remember only what they explicitly accept. That is trust-on-first-use —
// the same bargain SSH makes, and for the same reason.

const TRUST_FILE = () => path.join(app.getPath('userData'), 'trusted-certs.json');

function trustedFingerprints() {
  return readJson(TRUST_FILE(), {});
}

function trustCertificate(host, fingerprint) {
  const all = trustedFingerprints();
  all[host] = { fingerprint, trustedAt: new Date().toISOString() };
  writeJson(TRUST_FILE(), all);
}

function installCertificateGate() {
  app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* malformed URL; fall through to refuse */
    }
    const known = trustedFingerprints()[host];

    // Match on the fingerprint, not just the host: a certificate that changed
    // under a host we already trust is exactly the case worth stopping for.
    if (known && known.fingerprint === certificate.fingerprint) {
      event.preventDefault();
      callback(true);
      return;
    }

    callback(false);
    win?.webContents.send('cert:untrusted', {
      host,
      error,
      fingerprint: certificate.fingerprint,
      subject: certificate.subjectName,
      issuer: certificate.issuerName,
      validExpiry: certificate.validExpiry,
      changed: !!known,
    });
  });
}

let win = null;
let tray = null;
/** True only once the user has genuinely asked to quit, so the close button
 *  can hide to the tray without trapping them in a window they cannot shut. */
let quitting = false;
/** Mirrored from the renderer so the tray tooltip and menu can show it. */
let registration = { state: 'idle', detail: 'Not connected' };

/** Whether closing the window should hide rather than quit. Read from disk
 *  rather than held in memory because main needs it during `close`, which can
 *  fire before the renderer has told us anything. */
function keepInTray() {
  return readJson(paths().settings, {}).keepInTray === true;
}

const TRAY_LABEL = {
  idle: 'Offline',
  connecting: 'Connecting...',
  registered: 'Online',
  failed: 'Connection problem',
};

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`Dialtone - ${TRAY_LABEL[registration.state] || registration.state}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // A disabled first item is the cheapest always-visible status readout;
      // the tooltip only appears on hover.
      { label: TRAY_LABEL[registration.state] || registration.state, enabled: false },
      { type: 'separator' },
      { label: 'Open Dialtone', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  if (tray) return;
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  const image = fs.existsSync(icoPath)
    ? nativeImage.createFromPath(icoPath)
    : nativeImage.createEmpty();
  tray = new Tray(image);
  buildTrayMenu();
  // Left-click opens on Windows; the context menu is the right-click.
  tray.on('click', showWindow);
}

// --- the incoming-call popup ----------------------------------------------
//
// A separate frameless, transparent, always-on-top window pinned to the
// bottom-right corner. It exists because the main window is usually not what
// you are looking at when the phone rings: it is in the tray, or behind an
// editor. Dragging it to the front interrupts whatever you were doing to make
// a decision that needs two buttons.
//
// The window is larger than the card it contains and never moves. The card
// slides within it via a CSS transform, which the compositor handles; nudging
// a window's bounds sixty times a second does not look like the same thing.

const TOAST_W = 400;
const TOAST_H = 120;

let toast = null;
/** Resolves when the popup's page has loaded. Showing a window mid-load
 *  leaves it invisible with every other property looking correct. */
let toastReady = null;
/** Held so the popup can be re-rendered on reopen without waiting for the
 *  next per-second update from the renderer. */
let toastCall = null;

function toastBounds() {
  // workArea, not bounds: it excludes the taskbar, so the popup sits above it
  // rather than under it.
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - TOAST_W,
    y: workArea.y + workArea.height - TOAST_H,
    width: TOAST_W,
    height: TOAST_H,
  };
}

/**
 * Put the popup above everything, and keep it there.
 *
 * Three things are load-bearing here, learned the hard way — the popup was
 * only visible with the desktop showing:
 *
 * 1. **'screen-saver', not 'floating'.** On Windows the lower levels do not
 *    reliably map to the WS_EX_TOPMOST band, so an ordinary maximised window
 *    covers the popup.
 * 2. **It must be re-asserted AFTER showInactive().** SW_SHOWNOINACTIVATE
 *    shows without activating, and in doing so puts the window at the bottom
 *    of the z-order — discarding topmost set before the show. Setting it in
 *    the constructor alone is not enough.
 * 3. **setVisibleOnAllWorkspaces**, so a call on virtual desktop 2 is not
 *    announced on desktop 1 where nobody is looking.
 */
function raiseToast() {
  if (!toast || toast.isDestroyed()) return;
  toast.setAlwaysOnTop(true, 'screen-saver');
  // Windows has no concept of this and Electron documents it as a no-op
  // there; calling it anyway was a suspect while debugging a window that
  // would not appear, so it is scoped to the platforms that use it.
  if (process.platform !== 'win32') {
    toast.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  toast.moveTop();
}

function createToast() {
  if (toast) return toast;
  toast = new BrowserWindow({
    ...toastBounds(),
    show: false,
    frame: false,
    transparent: true,
    // We draw the shadow in CSS; the OS one would trace the whole transparent
    // window, including the empty area the card slides through.
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-toast.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  raiseToast();
  toastReady = new Promise((resolve) => {
    toast.webContents.once('did-finish-load', resolve);
  });
  toast.loadFile(path.join(__dirname, 'src', 'toast.html'));
  toast.on('closed', () => {
    toast = null;
    toastReady = null;
  });
  return toast;
}

/** Should the popup be used, or is the app already in front of the person? */
function appIsInForeground() {
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused();
}

/**
 * Show the popup, once its page is actually loaded.
 *
 * Showing a window that is still loading is how it ends up with the topmost
 * flag set, correct bounds, and `isVisible() === false` — which looks
 * identical to a z-order problem and is not one. The window is created at
 * startup so in practice this promise is long since resolved by the time the
 * phone rings; awaiting it is what makes the very first call behave like
 * every other one.
 */
async function showToast(call) {
  toastCall = call;
  const t = createToast();
  await toastReady;
  if (!toast || toast.isDestroyed()) return;

  // Show FIRST, then send the state. The other order looks correct and is
  // not: the renderer reveals the card on a requestAnimationFrame, and
  // Chromium does not run those for a window that is not on screen yet. The
  // window would appear — visible, topmost, right bounds — containing a card
  // still parked off-screen at opacity 0. Because the window is transparent,
  // that is indistinguishable from a z-order bug: you see straight through to
  // whatever is behind it.
  if (!t.isVisible()) {
    t.setBounds(toastBounds());
    // showInactive, not show: raising the popup must not steal focus from
    // whatever the person is typing into. They can still click it.
    t.showInactive();
  }
  raiseToast();

  t.webContents.send('toast:theme', readJson(paths().settings, {}).theme || 'dark');
  t.webContents.send('toast:call', call);
  // After the show, never before — see raiseToast(). Also re-asserted when
  // the popup is already up, in case something has since been promoted above
  // it.
  raiseToast();

  if (DEV) {
    console.log(
      `[toast] visible=${t.isVisible()} topmost=${t.isAlwaysOnTop()} ` +
        `bounds=${JSON.stringify(t.getBounds())}`
    );
  }
}

function updateToast(call) {
  toastCall = call;
  if (toast && toast.isVisible()) toast.webContents.send('toast:call', call);
}

/** Ask the popup to slide out. It reports back when the animation is done,
 *  and only then is the window hidden. */
function dismissToast() {
  toastCall = null;
  if (toast && toast.isVisible()) toast.webContents.send('toast:dismiss');
}

/** Render the window to a PNG and quit. Dev-only; see SHOT above. */
async function captureAndExit() {
  try {
    if (FORCE_THEME) {
      await win.webContents.executeJavaScript(
        `document.documentElement.dataset.theme = ${JSON.stringify(FORCE_THEME)}`
      );
    }
    // `--route toast:<state>` photographs the call popup instead of the main
    // window. It is its own window, so nothing else can capture it, and it is
    // the piece most worth looking at before shipping.
    if (ROUTE && ROUTE.startsWith('toast')) {
      const status = ROUTE.split(':')[1] || 'ringing';
      showToast({
        active: true,
        direction: 'in',
        status,
        number: '+302114443742',
        name: 'Ada Lovelace',
        seconds: 134,
      });
      // Long enough for the slide-in to finish, so the shot is of the settled
      // card rather than a frame mid-transition.
      await new Promise((r) => setTimeout(r, 900));
      const shot = await toast.webContents.capturePage();
      fs.writeFileSync(SHOT, shot.toPNG());
      console.log(`captured ${SHOT}`);
      app.exit(0);
      return;
    }
    if (ROUTE === 'cert') {
      await win.webContents.executeJavaScript('window.__previewCert && window.__previewCert()');
    } else if (ROUTE && ROUTE.startsWith('call:')) {
      // call:connected, call:ringing, call:incoming
      const [, status] = ROUTE.split(':');
      const direction = status === 'incoming' ? 'in' : 'out';
      const st = status === 'incoming' ? 'ringing' : status;
      await win.webContents.executeJavaScript(
        `window.__previewCall && window.__previewCall(${JSON.stringify(st)}, ${JSON.stringify(direction)})`
      );
    } else if (ROUTE) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.rail-btn[data-view="${ROUTE}"]')?.click()`
      );
    }
    if (SCROLL) {
      await new Promise((r) => setTimeout(r, 400));
      await win.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(SCROLL)})?.scrollIntoView({block:'start'})`
      );
    }
    if (CLICK) {
      await new Promise((r) => setTimeout(r, 400));
      await win.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(CLICK)})?.click()`
      );
    }
    // Let the view transition and any async render settle before the shutter.
    await new Promise((r) => setTimeout(r, 900));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, image.toPNG());
    console.log(`captured ${SHOT}`);
  } catch (err) {
    console.error('capture failed', err);
  }
  app.exit(0);
}

/** Run test/smoke.js inside the renderer and report. Dev-only. */
async function runSelfTest() {
  const source = fs.readFileSync(path.join(__dirname, SELFTEST), 'utf8');
  let code = 1;
  try {
    const out = await win.webContents.executeJavaScript(source, true);
    for (const r of out.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    }
    console.log(`\n${out.passed} passed, ${out.failed} failed`);
    code = out.failed === 0 ? 0 : 1;
  } catch (err) {
    console.error('self-test threw:', err?.message || err);
  }
  app.exit(code);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0b0d10',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Lets the renderer know it may install debug hooks. Absent in a normal
      // run, so those hooks do not exist in the shipped app at all.
      additionalArguments: DEV ? ['--dialtone-dev'] : [],
      // The renderer holds a live WebRTC session; background throttling
      // would stall audio the moment the window loses focus.
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Paint once, rather than showing an empty frame and then the UI.
  win.once('ready-to-show', () => {
    // Started by the login item: register and sit in the tray. Showing a
    // window at every login is what makes people turn autostart back off.
    if (!START_IN_TRAY) win.show();
    if (DEV && !SHOT && !SELFTEST) win.webContents.openDevTools({ mode: 'detach' });
    if (SHOT) captureAndExit();
    if (SELFTEST) runSelfTest();
  });

  // Closing hides rather than quits when asked to. A softphone that stops
  // running when you close its window silently stops taking calls, which is
  // the one thing it exists to do.
  win.on('close', (e) => {
    if (quitting || !keepInTray()) return;
    e.preventDefault();
    win.hide();
  });

  // Renderer errors are invisible from a terminal otherwise, and a softphone
  // that silently fails to wire up its call screen looks identical to one
  // that is merely idle.
  if (DEV) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = ['LOG', 'WARN', 'ERROR', 'INFO'][level] || level;
      const where = source ? ` (${path.basename(String(source))}:${line})` : '';
      console.log(`[renderer:${tag}]${where} ${message}`);
    });
  }

  // The custom titlebar needs to know which glyph to draw.
  const tellRenderer = () => win.webContents.send('window:state', { maximized: win.isMaximized() });
  win.on('maximize', tellRenderer);
  win.on('unmaximize', tellRenderer);

  // Anything that isn't the app opens in the real browser, not in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

// The renderer asks for the microphone; Electron asks us. Only ever grant
// the two permissions a softphone actually needs.
function installPermissionGate() {
  const ALLOWED = new Set(['media', 'audioCapture']);
  const session = require('electron').session.defaultSession;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

// Without an explicit AppUserModelID, Windows groups the taskbar button under
// "electron.exe" and shows Electron's default icon there regardless of what
// the shortcut says — the window icon alone does not fix it.
if (process.platform === 'win32') app.setAppUserModelId('com.alexk.dialtone');

app.whenReady().then(async () => {
  installPermissionGate();
  installCertificateGate();

  // On Windows this is a no-op, but asking is what makes the OS mic prompt
  // appear at a sensible moment on macOS rather than mid-call.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      /* the call will fail later with a clearer message than we can give here */
    }
  }

  createWindow();
  // Not created during a screenshot or self-test run: a tray icon appearing
  // and vanishing for every capture is noise, and the process exits anyway.
  if (!SHOT && !SELFTEST) createTray();
  // NOT created here. Building the popup at startup and leaving it hidden
  // until the phone rings sounds better - the page is loaded, so showing it
  // is instant - and produces a window that reports visible, topmost and
  // correctly positioned while painting nothing at all. A transparent window
  // that sits hidden loses its compositor surface, and because it is
  // transparent you see straight through to whatever is behind: identical on
  // screen to the popup opening underneath everything.
  //
  // Created per call instead, and awaited before showing. See showToast().

  if (TOAST_DEMO) {
    win.hide();
    showToast({
      active: true,
      direction: 'in',
      status: 'ringing',
      number: '+302114443742',
      name: 'Ada Lovelace',
      seconds: 0,
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // With a tray icon the app deliberately outlives its window.
  if (tray && keepInTray()) return;
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ------------------------------------------------------------------

/** Obviously-fictional sample data for `--seed`, so list views can be
 *  reviewed without touching the real address book. Never written to disk. */
function seedData() {
  const hour = 3600000;
  const now = Date.now();
  return {
    contacts: [
      { id: 's1', name: 'Reception Desk', number: '1000', company: 'Front office', note: '', favorite: true, createdAt: now },
      { id: 's2', name: 'Ada Lovelace', number: '1001', company: 'Engineering', note: 'Prefers afternoons.', favorite: true, createdAt: now },
      { id: 's3', name: 'Grace Hopper', number: '1002', company: 'Engineering', note: '', favorite: false, createdAt: now },
      { id: 's4', name: 'Alan Turing', number: '+442071234567', company: '', note: '', favorite: false, createdAt: now },
      { id: 's5', name: 'Voicemail', number: '*97', company: '', note: '', favorite: false, createdAt: now },
      { id: 's6', name: 'Katherine Johnson', number: '1004', company: 'Operations', note: '', favorite: false, createdAt: now },
    ],
    history: [
      { id: 'h1', number: '1001', name: 'Ada Lovelace', direction: 'out', startedAt: now - 0.4 * hour, duration: 214 },
      { id: 'h2', number: '+442071234567', name: '', direction: 'missed', startedAt: now - 2 * hour, duration: 0 },
      { id: 'h3', number: '1000', name: 'Reception Desk', direction: 'in', startedAt: now - 5 * hour, duration: 63 },
      { id: 'h4', number: '1002', name: '', direction: 'out', startedAt: now - 26 * hour, duration: 1290 },
      { id: 'h5', number: '2125550143', name: '', direction: 'missed', startedAt: now - 28 * hour, duration: 0 },
      { id: 'h6', number: '1001', name: 'Ada Lovelace', direction: 'in', startedAt: now - 50 * hour, duration: 45 },
      { id: 'h7', number: '*97', name: 'Voicemail', direction: 'out', startedAt: now - 74 * hour, duration: 22 },
    ],
  };
}

ipcMain.handle('store:load', () => {
  const p = paths();
  const settings = readJson(p.settings, {});
  const seed = SEED ? seedData() : null;
  return {
    settings: seed
      ? { ...settings, displayName: 'Alex', username: '1005', domain: 'pbx.local', wsUrl: 'wss://pbx.local:7443', password: '' }
      : { ...settings, password: loadPassword() },
    contacts: seed ? seed.contacts : readJson(p.contacts, []),
    history: seed ? seed.history : readJson(p.history, []),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle('store:saveSettings', (_e, settings) => {
  // Seeded runs are for looking at the UI. Letting them write would replace
  // the real account and address book with the sample data.
  if (SEED) return { ok: true, encrypted: false };
  const { password, ...rest } = settings || {};
  const result = savePassword(password);
  writeJson(paths().settings, rest);
  return result;
});

ipcMain.handle('store:saveContacts', (_e, contacts) => {
  if (SEED) return true;
  writeJson(paths().contacts, contacts || []);
  return true;
});

ipcMain.handle('store:saveHistory', (_e, history) => {
  if (SEED) return true;
  writeJson(paths().history, history || []);
  return true;
});

ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => win?.close());
ipcMain.handle('window:isMaximized', () => !!win?.isMaximized());

/** Keep the screen awake during a call — a machine that sleeps mid-sentence
 *  is a dropped call. */
let wakeLock = null;
ipcMain.handle('power:keepAwake', (_e, on) => {
  const { powerSaveBlocker } = require('electron');
  if (on && wakeLock === null) {
    wakeLock = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!on && wakeLock !== null) {
    powerSaveBlocker.stop(wakeLock);
    wakeLock = null;
  }
  return wakeLock !== null;
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  dataDir: app.getPath('userData'),
}));

ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

ipcMain.handle('cert:trust', (_e, { host, fingerprint }) => {
  if (!host || !fingerprint) return false;
  trustCertificate(host, fingerprint);
  return true;
});

ipcMain.handle('cert:list', () => trustedFingerprints());

// --- import / export ------------------------------------------------------

const BUNDLE_VERSION = 1;

ipcMain.handle('config:export', async (_e, { includePassword }) => {
  const settings = readJson(paths().settings, {});
  const bundle = {
    app: 'dialtone',
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    // The password is opt-in and travels in clear text inside the file. It
    // cannot be re-encrypted for another machine — safeStorage keys are
    // per-user and per-machine — so the honest options are "leave it out" or
    // "it is readable to anyone holding this file".
    passwordIncluded: !!includePassword,
    settings: { ...settings, password: includePassword ? loadPassword() : '' },
    contacts: readJson(paths().contacts, []),
    history: readJson(paths().history, []),
  };

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Dialtone configuration',
    defaultPath: `dialtone-config-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Dialtone configuration', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
  return {
    ok: true,
    filePath,
    counts: { contacts: bundle.contacts.length, history: bundle.history.length },
  };
});

ipcMain.handle('config:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Dialtone configuration',
    properties: ['openFile'],
    filters: [{ name: 'Dialtone configuration', extensions: ['json'] }],
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };

  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  } catch (err) {
    return { ok: false, error: `Not readable JSON: ${err.message}` };
  }

  // Validate before showing counts, so a wrong file is rejected rather than
  // half-applied.
  if (bundle?.app !== 'dialtone') {
    return { ok: false, error: 'This is not a Dialtone configuration file.' };
  }
  if (typeof bundle.version !== 'number' || bundle.version > BUNDLE_VERSION) {
    return { ok: false, error: `Made by a newer version of Dialtone (v${bundle.version}).` };
  }

  return {
    ok: true,
    filePath: filePaths[0],
    bundle: {
      settings: bundle.settings && typeof bundle.settings === 'object' ? bundle.settings : {},
      contacts: Array.isArray(bundle.contacts) ? bundle.contacts : [],
      history: Array.isArray(bundle.history) ? bundle.history : [],
      passwordIncluded: !!bundle.passwordIncluded,
      exportedAt: bundle.exportedAt || '',
    },
  };
});

// --- run at startup -------------------------------------------------------

/**
 * The login item's identity.
 *
 * Both get and set must be given the SAME path and args. On Windows
 * `getLoginItemSettings()` with no arguments looks for an entry registered
 * under the default path and no arguments; ours is registered under
 * electron.exe with the app directory and `--tray`, so the bare call reports
 * `openAtLogin: false` for an entry that exists and works. That looks exactly
 * like the write having failed.
 *
 * Unpackaged, execPath is electron.exe and the app directory has to be the
 * first argument or the login item launches Electron's default page.
 */
function loginItemOptions() {
  // Packaged, execPath IS Dialtone.exe and takes --tray directly. Unpackaged,
  // execPath is electron.exe and the app directory has to be the first
  // argument or the login item launches Electron's default page instead.
  // Passing the unpackaged form to an installed build points the login item
  // at a path inside app.asar, which fails silently at every login.
  return app.isPackaged
    ? { path: process.execPath, args: ['--tray'] }
    : { path: process.execPath, args: [app.getAppPath(), '--tray'] };
}

ipcMain.handle('startup:get', () => app.getLoginItemSettings(loginItemOptions()).openAtLogin);

ipcMain.handle('startup:set', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItemOptions() });
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
});

// --- tray + attention -----------------------------------------------------

ipcMain.handle('tray:registration', (_e, state) => {
  registration = state || registration;
  buildTrayMenu();
  return true;
});

/**
 * Bring the window forward for an incoming call.
 *
 * Windows will refuse focus to a background process often enough that
 * `show()`+`focus()` alone is unreliable, so the taskbar flash is a fallback
 * rather than a flourish: if the OS declines to raise the window, the button
 * still blinks. The brief always-on-top is what actually wins the race in
 * most cases; it is dropped again immediately so the app does not sit above
 * everything else for the rest of the call.
 */
ipcMain.handle('window:attention', () => {
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
  win.flashFrame(true);
  return true;
});

ipcMain.handle('window:stopAttention', () => {
  win?.flashFrame(false);
  return true;
});

// --- call popup -----------------------------------------------------------

/**
 * Called by the renderer on every change to an active call.
 *
 * Main decides whether the popup is warranted, because only main knows
 * whether the window is visible, minimised or focused — the renderer can see
 * document focus but not that it is sitting in the tray.
 *
 * @returns {boolean} whether the popup is currently showing
 */
ipcMain.handle('toast:sync', (_e, call) => {
  if (!call || !call.active || call.status === 'ended') {
    dismissToast();
    return false;
  }
  // Outbound calls never get a popup: you are already looking at the app, you
  // just dialled from it.
  if (call.direction !== 'in') return false;

  const showing = !!toast && toast.isVisible();
  if (showing) {
    updateToast(call);
    return true;
  }
  // Only on the ringing edge. If the app was in front when it rang and the
  // person then alt-tabbed away mid-call, popping a window up at them is not
  // what they asked for.
  if (call.status === 'ringing' && !appIsInForeground()) {
    showToast(call);
    return true;
  }
  return false;
});

ipcMain.on('toast:answer', () => win?.webContents.send('call:answer'));
ipcMain.on('toast:decline', () => win?.webContents.send('call:hangup'));
ipcMain.on('toast:open', () => {
  showWindow();
  dismissToast();
});
ipcMain.on('toast:dismissed', () => {
  // Hidden rather than closed: recreating the window per call would mean
  // reloading the page each time, and the first slide would stutter.
  if (toast && !toast.isDestroyed()) toast.hide();
});

ipcMain.handle('cert:forget', (_e, host) => {
  const all = trustedFingerprints();
  delete all[host];
  writeJson(TRUST_FILE(), all);
  return true;
});
