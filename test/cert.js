/**
 * The certificate trust flow, end to end, through the real UI.
 *
 * Needs `node test/wss-server.js` running first — a TLS WebSocket server with
 * a freshly generated self-signed certificate, which is exactly the situation
 * a self-hosted PBX presents.
 *
 * This drives the actual dialog rather than calling the IPC directly, because
 * the thing worth proving is not "the main process can store a fingerprint"
 * but "a person who clicks Trust ends up with a working socket".
 *
 *   node test/wss-server.js &
 *   electron . --dev --seed --selftest test/cert.js
 */

(async () => {
  const results = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poll until a predicate holds, or give up. Cheaper to reason about than
   *  wiring observers into three different async systems. */
  async function waitFor(label, predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(120);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  const app = window.__dialtone;
  const { store, phone } = app;
  const SERVER = 'wss://127.0.0.1:7443';

  // Start from a clean slate, or a fingerprint trusted by an earlier run
  // would make the first assertion pass for the wrong reason.
  await window.dialtone.certs.forget('127.0.0.1:7443');

  await check('an untrusted certificate is refused, and explained', async () => {
    await store.saveSettings({
      wsUrl: SERVER,
      username: '1001',
      domain: 'pbx.local',
      password: 'irrelevant',
    });
    app.connect();

    const scrim = await waitFor('the certificate dialog', () => {
      const el = document.querySelector('.scrim.on');
      return el && /certificate/i.test(el.textContent) ? el : null;
    });

    const text = scrim.textContent;
    assert(/127\.0\.0\.1:7443/.test(text), 'the dialog does not name the host');
    assert(/SHA-256/i.test(text), 'no fingerprint shown');
    // A fingerprint the person cannot compare is a checkbox, not a decision.
    assert(/([0-9A-F]{2}:){10}/i.test(text), 'fingerprint is not in comparable form');
    return text.match(/([0-9A-F]{2}:){8,}[0-9A-F]{2}/i)?.[0].slice(0, 23) + '…';
  });

  await check('the socket is NOT open while the certificate is refused', () => {
    assert(!phone.isRegistered(), 'registered against an untrusted certificate');
    return 'refused';
  });

  await check('clicking Trust opens the connection', async () => {
    // Watch registration events: JsSIP only reports "connected" once the
    // WebSocket has actually opened, which is precisely what TLS was blocking.
    let sawSocketOpen = false;
    const off = phone.on('registration', (ev) => {
      if (ev.state === 'connecting' && /registering/i.test(ev.detail)) sawSocketOpen = true;
    });

    document.querySelector('.scrim.on [data-act="ok"]').click();

    try {
      await waitFor('the WebSocket to open', () => sawSocketOpen, 15000);
    } finally {
      off();
    }
    return 'TLS handshake completed and the socket upgraded';
  });

  await check('the trusted fingerprint was remembered', async () => {
    const all = await window.dialtone.certs.list();
    const entry = all['127.0.0.1:7443'];
    assert(entry, 'nothing stored for the host');
    assert(/^sha256\//i.test(entry.fingerprint), `odd fingerprint: ${entry.fingerprint}`);
    return entry.fingerprint.slice(0, 30) + '…';
  });

  phone.disconnect();
  await window.dialtone.certs.forget('127.0.0.1:7443');

  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
})();
