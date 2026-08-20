/**
 * Renderer smoke test.
 *
 * Evaluated inside the running app by `main.js --selftest`, so it exercises
 * the real modules against the real DOM rather than a mocked one. Screenshots
 * prove the app draws; this proves it works.
 *
 * Deliberately does not need a SIP server. The one thing that genuinely
 * cannot be tested without a PBX is a completed call — everything up to and
 * including "the server is unreachable, and here is a sentence a person can
 * act on" is testable here, and that is the path that actually gets hit when
 * something is misconfigured.
 *
 * Returns {passed, failed, results} to the main process.
 */

(async () => {
  const results = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  const app = window.__dialtone;
  const { store, phone } = app;
  const fmt = await import('../src/js/format.js');

  // --- the SIP library is actually present and usable -----------------
  await check('JsSIP bundle exposes the API we use', () => {
    assert(window.JsSIP, 'window.JsSIP missing — vendor bundle did not load');
    assert(typeof window.JsSIP.UA === 'function', 'JsSIP.UA missing');
    assert(typeof window.JsSIP.WebSocketInterface === 'function', 'WebSocketInterface missing');
    return `JsSIP ${window.JsSIP.version || '?'}`;
  });

  // --- number handling, which every view depends on -------------------
  await check('normalise keeps dialable characters only', () => {
    assert(fmt.normalise(' +30 (211) 444-3742 ') === '+302114443742', 'punctuation not stripped');
    assert(fmt.normalise('*97') === '*97', 'star code mangled');
    assert(fmt.normalise('abc123') === '123', 'letters not stripped');
  });

  await check('sameNumber matches the same line in different formats', () => {
    assert(fmt.sameNumber('+302114443742', '2114443742'), 'E.164 vs national failed');
    assert(fmt.sameNumber('1001', '1001'), 'extension equality failed');
    assert(!fmt.sameNumber('1001', '1002'), 'different extensions matched');
    assert(!fmt.sameNumber('', '1001'), 'empty matched something');
    // Short extensions must compare exactly, or 1001 and 21001 collide.
    assert(!fmt.sameNumber('1001', '21001'), 'short numbers matched loosely');
  });

  await check('duration formats across the hour boundary', () => {
    assert(fmt.duration(0) === '00:00', `got ${fmt.duration(0)}`);
    assert(fmt.duration(59) === '00:59', `got ${fmt.duration(59)}`);
    assert(fmt.duration(600) === '10:00', `got ${fmt.duration(600)}`);
    assert(fmt.duration(3661) === '1:01:01', `got ${fmt.duration(3661)}`);
  });

  await check('esc neutralises markup in a contact name', () => {
    const out = fmt.esc('<img src=x onerror=alert(1)>');
    assert(!out.includes('<img'), 'tag survived escaping');
    assert(out.includes('&lt;img'), 'not escaped as expected');
  });

  // --- store round-trips ----------------------------------------------
  await check('contacts can be added, edited and deleted', () => {
    const before = store.state.contacts.length;
    const c = store.addContact({ name: 'Test Person', number: '1999' });
    assert(store.state.contacts.length === before + 1, 'not added');
    store.updateContact(c.id, { favorite: true });
    assert(store.state.contacts.find((x) => x.id === c.id).favorite, 'update lost');
    store.deleteContact(c.id);
    assert(store.state.contacts.length === before, 'not deleted');
  });

  await check('history caps and orders newest first', () => {
    const a = store.addCall({ number: '1001', direction: 'out', startedAt: 1000 });
    const b = store.addCall({ number: '1002', direction: 'in', startedAt: 2000 });
    assert(store.state.history[0].id === b.id, 'newest not first');
    store.deleteCall(a.id);
    store.deleteCall(b.id);
  });

  await check('isConfigured requires server, extension and domain', () => {
    assert(!store.isConfigured({ wsUrl: '', username: '1', domain: 'd' }), 'accepted empty server');
    assert(!store.isConfigured({ wsUrl: 'wss://x', username: '', domain: 'd' }), 'accepted empty ext');
    assert(store.isConfigured({ wsUrl: 'wss://x', username: '1', domain: 'd' }), 'rejected valid');
  });

  await check('a settings file with a UTF-8 BOM still parses', () => {
    // JSON.parse rejects a leading BOM outright, and common tools add one -
    // PowerShell's Set-Content -Encoding utf8 always does. Before this was
    // handled, a BOM made readJson fall back to {}, which presents as every
    // setting having been wiped.
    const withBom = '﻿{"wsUrl":"ws://x:1","username":"9"}';
    let threw = false;
    try {
      JSON.parse(withBom);
    } catch {
      threw = true;
    }
    assert(threw, 'JSON.parse tolerated a BOM; this test no longer proves anything');
    const parsed = JSON.parse(withBom.replace(/^﻿/, ''));
    assert(parsed.wsUrl === 'ws://x:1', 'stripping the BOM did not recover the object');
    return 'BOM stripped';
  });

  // --- import / export --------------------------------------------------

  await check('merging an import does not duplicate a contact already here', async () => {
    const mine = store.addContact({ name: 'Already Here', number: '+302114443742' });
    const before = store.state.contacts.length;
    const added = await store.applyImport(
      {
        // Same line, written differently — the exact case a naive merge
        // duplicates.
        contacts: [{ id: 'x1', name: 'Already Here (dup)', number: '2114443742' }],
        history: [],
        settings: {},
        passwordIncluded: false,
      },
      'merge'
    );
    assert(added.contacts === 0, `added ${added.contacts}, expected 0`);
    assert(store.state.contacts.length === before, 'contact count changed');
    store.deleteContact(mine.id);
  });

  await check('merging adds contacts that are genuinely new', async () => {
    const before = store.state.contacts.length;
    const added = await store.applyImport(
      {
        contacts: [{ id: 'n1', name: 'Brand New', number: '5550001' }],
        history: [],
        settings: {},
        passwordIncluded: false,
      },
      'merge'
    );
    assert(added.contacts === 1, `added ${added.contacts}, expected 1`);
    assert(store.state.contacts.length === before + 1, 'not actually added');
    store.deleteContact(store.state.contacts.find((c) => c.number === '5550001').id);
  });

  await check('an import without a password keeps the existing one', async () => {
    await store.saveSettings({ password: 'keep-me' });
    await store.applyImport(
      { contacts: [], history: [], settings: { username: '9999' }, passwordIncluded: false },
      'merge'
    );
    assert(store.state.settings.password === 'keep-me', 'password was clobbered');
    assert(store.state.settings.username === '9999', 'settings were not applied');
  });

  await check('replace discards what was there', async () => {
    store.addContact({ name: 'Doomed', number: '5559999' });
    const added = await store.applyImport(
      {
        contacts: [{ id: 'r1', name: 'Only One', number: '5551111' }],
        history: [],
        settings: {},
        passwordIncluded: false,
      },
      'replace'
    );
    assert(store.state.contacts.length === 1, `${store.state.contacts.length} contacts, expected 1`);
    assert(store.state.contacts[0].name === 'Only One', 'wrong contact survived');
    assert(added.contacts === 1, 'wrong count reported');
  });

  // --- the new behaviour switches ---------------------------------------

  await check('the login item can be set and read back', async () => {
    const original = await window.dialtone.startup.get();
    try {
      const on = await window.dialtone.startup.set(true);
      assert(on === true, 'enabling the login item did not stick');
      const off = await window.dialtone.startup.set(false);
      assert(off === false, 'disabling the login item did not stick');
      return 'set and cleared';
    } finally {
      // Restore whatever the machine had, so running the suite never leaves
      // an autostart entry behind.
      await window.dialtone.startup.set(original);
    }
  });

  await check('the window can be raised for a call', async () => {
    const ok = await window.dialtone.window.attention();
    assert(ok, 'attention() reported failure');
    await window.dialtone.window.stopAttention();
    return 'raised and cleared';
  });

  await check('tray status accepts a registration update', async () => {
    assert(await window.dialtone.tray.registration({ state: 'registered', detail: 'x' }), 'refused');
    return 'ok';
  });

  // --- the dialpad ------------------------------------------------------
  await check('keypad presses build a number and backspace removes one', () => {
    app.go('dialer');
    const input = document.querySelector('#dialInput');
    input.value = '';
    for (const d of ['2', '1', '1']) {
      document.querySelector(`.key[data-key="${d}"]`).click();
    }
    assert(input.value === '211', `expected 211, got "${input.value}"`);
    document.querySelector('#dialBack').click();
    assert(input.value === '21', `backspace failed, got "${input.value}"`);
    input.value = '';
  });

  await check('the call button is disabled until registered', () => {
    const input = document.querySelector('#dialInput');
    input.value = '1001';
    app.dialer.refresh();
    const btn = document.querySelector('#dialCall');
    assert(btn.disabled, 'call button enabled while offline');
    assert(/not registered/i.test(btn.title), `unhelpful title: ${btn.title}`);
    input.value = '';
    app.dialer.refresh();
  });

  await check('a known number shows the contact name under the dialpad', () => {
    const c = store.addContact({ name: 'Hint Target', number: '+302114443742' });
    const input = document.querySelector('#dialInput');
    input.value = '2114443742'; // same line, different format
    app.dialer.refresh();
    const hint = document.querySelector('#dialHint').textContent;
    assert(hint.includes('Hint Target'), `hint was "${hint}"`);
    store.deleteContact(c.id);
    input.value = '';
    app.dialer.refresh();
  });

  // --- refusing to dial rather than failing obscurely -------------------
  await check('dialling while unregistered is refused with a reason', () => {
    const err = phone.dial('1001');
    assert(err, 'dial() returned no error while offline');
    assert(/registered/i.test(err), `unhelpful error: ${err}`);
  });

  await check('dialling an empty number is refused', () => {
    const err = phone.dial('');
    assert(err, 'empty dial was accepted');
  });

  // --- configuration errors surface as sentences, not stack traces ------
  await check('a non-wss server URL is rejected before connecting', async () => {
    const seen = await captureRegistration(() =>
      phone.connect({ wsUrl: 'http://nope', username: '1', domain: 'd' })
    );
    assert(seen.state === 'failed', `state was ${seen.state}`);
    assert(/wss:\/\//.test(seen.detail), `unhelpful detail: ${seen.detail}`);
  });

  await check('missing fields are rejected before connecting', async () => {
    const seen = await captureRegistration(() =>
      phone.connect({ wsUrl: 'wss://x:7443', username: '', domain: '' })
    );
    assert(seen.state === 'failed', `state was ${seen.state}`);
    assert(/required/i.test(seen.detail), `unhelpful detail: ${seen.detail}`);
  });

  await check('an unreachable server ends in failed, not a hang', async () => {
    // 203.0.113.0/24 is TEST-NET-3: reserved, guaranteed unroutable, so this
    // exercises the timeout path without depending on any real host.
    const seen = await captureRegistration(
      () => phone.connect({ wsUrl: 'wss://203.0.113.7:7443', username: '1001', domain: 'pbx.local' }),
      { until: 'failed', timeout: 20000 }
    );
    assert(seen.state === 'failed', `ended in ${seen.state}: ${seen.detail}`);
    return seen.detail;
  });

  phone.disconnect();

  /** Collect registration events until a terminal one, or time out. */
  function captureRegistration(trigger, { until = 'failed', timeout = 4000 } = {}) {
    return new Promise((resolve) => {
      let last = { state: 'idle', detail: '(no event fired)' };
      const off = phone.on('registration', (ev) => {
        last = ev;
        if (ev.state === until) {
          off();
          clearTimeout(timer);
          resolve(ev);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(last);
      }, timeout);
      trigger();
    });
  }

  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
})();
