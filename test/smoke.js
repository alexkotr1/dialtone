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

  // --- voice transformation ---------------------------------------------
  //
  // The DSP has its own measurement harness in tools/voicelab, which checks
  // accuracy against synthetic speech with known pitch and formants. What is
  // worth checking HERE is the part that harness cannot see: that the module
  // still loads in the real renderer, that bypass is genuinely a no-op, and
  // that pitch and formants remain independent - the property the whole design
  // exists for, and the one a careless edit would silently destroy.

  const { VoiceChanger, PRESETS } = await import('../src/js/dsp/voicechanger.js');
  const { FFT } = await import('../src/js/dsp/fft.js');
  const voicefx = await import('../src/js/voicefx.js');

  /**
   * A vowel: glottal pulses through a resonator at 1000Hz.
   *
   * Source-filter, not a sum of sinusoids. A bare harmonic stack has literal
   * zeros between its partials, and the log-spectrum valleys that creates drag
   * the cepstral envelope far below the peaks - so the whitening step leaves a
   * huge tilt in the excitation and the measurement reports formant motion
   * that a real microphone would never produce. Every real source has a
   * continuous spectrum; testing against one that does not measures the test
   * signal rather than the code.
   */
  const vowelish = (n, f0, sr) => {
    const src = new Float32Array(n);
    // Deterministic PRNG: the same waveform every run, so a failure is
    // reproducible rather than a coin toss.
    let seed = 22222;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x3fffffff - 1;
    };
    let t = 0;
    while (t < n) {
      // Jitter and shimmer, at the couple of percent a healthy voice has.
      // Without them the excitation is perfectly periodic, the spectrum has
      // true nulls between its harmonics, and the log of those nulls drags any
      // cepstral envelope estimate far below the peaks - so the test measures
      // an artefact of an impossible signal. Real vocal folds never repeat a
      // period exactly.
      const period = (sr / f0) * (1 + rnd() * 0.012);
      const amp = 1 + rnd() * 0.05;
      const start = Math.floor(t);
      const len = Math.max(4, Math.floor(period * 0.6));
      for (let i = 0; i < len && start + i < n; i++) {
        const k = i / len;
        // Rosenberg pulse: slow rise, faster fall.
        src[start + i] += amp * (k < 0.6
          ? 3 * (k / 0.6) ** 2 - 2 * (k / 0.6) ** 3
          : 1 - ((k - 0.6) / 0.4) ** 2);
      }
      t += period;
    }
    // Radiation at the lips is a differentiator (+6dB/octave).
    const x = new Float32Array(n);
    for (let i = 1; i < n; i++) x[i] = src[i] - src[i - 1];
    // Three formants, at the measured averages for /a/. One resonator is not
    // enough: it leaves most of the band nearly empty, the envelope estimate
    // there is unconstrained, and the test then measures that rather than the
    // transform. A vowel is several resonances spanning the range.
    for (const [freq, bw] of [[730, 60], [1090, 90], [2440, 120]]) {
      const r = Math.exp((-Math.PI * bw) / sr);
      const theta = (2 * Math.PI * freq) / sr;
      const a1 = 2 * r * Math.cos(theta);
      const a2 = -r * r;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < n; i++) {
        const y = x[i] * (1 - r) + a1 * y1 + a2 * y2;
        y2 = y1;
        y1 = y;
        x[i] = y;
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
    for (let i = 0; i < n; i++) x[i] = (x[i] / peak) * 0.5;
    return x;
  };

  /** F0 by autocorrelation, over the steady part only. */
  const measureF0 = (x, sr, from) => {
    const seg = x.subarray(from, from + 8192);
    let best = 0;
    let bestLag = 0;
    for (let lag = Math.floor(sr / 400); lag < Math.floor(sr / 60); lag++) {
      let acc = 0;
      for (let i = 0; i + lag < seg.length; i++) acc += seg[i] * seg[i + lag];
      if (acc > best) { best = acc; bestLag = lag; }
    }
    return bestLag ? sr / bestLag : 0;
  };

  const runDsp = (params, sr = 48000, secs = 0.9) => {
    const n = Math.floor(sr * secs);
    const input = vowelish(n, 120, sr);
    const out = new Float32Array(n);
    const vc = new VoiceChanger(sr);
    vc.setParams(params);
    for (let i = 0; i < n; i += 128) {
      const len = Math.min(128, n - i);
      vc.process(input.subarray(i, i + len), out.subarray(i, i + len));
    }
    return { input, out, sr, latency: vc.latency };
  };

  await check('FFT inverts itself', () => {
    const N = 256;
    const f = new FFT(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const orig = new Float32Array(N);
    for (let i = 0; i < N; i++) { orig[i] = Math.sin((7 * 2 * Math.PI * i) / N); re[i] = orig[i]; }
    f.forward(re, im);
    f.inverse(re, im);
    let err = 0;
    for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(re[i] - orig[i]));
    assert(err < 1e-4, `round-trip error ${err}`);
    return `max error ${err.toExponential(1)}`;
  });

  await check('bypass passes audio through unchanged', () => {
    const { input, out, latency } = runDsp({ pitch: 1, formant: 1, brightness: 0 });
    // Compare past the priming region, allowing for algorithmic latency.
    let err = 0;
    for (let i = latency + 4096; i < input.length - 1; i++) {
      err = Math.max(err, Math.abs(out[i] - input[i - latency]));
    }
    assert(err < 0.05, `bypass altered the signal by ${err.toFixed(3)}`);
    return `max deviation ${err.toFixed(4)}`;
  });

  await check('the output is always finite', () => {
    for (const p of [{ pitch: 2.4, formant: 1.9 }, { pitch: 0.42, formant: 0.55 }]) {
      const { out } = runDsp(p);
      for (let i = 0; i < out.length; i++) {
        assert(Number.isFinite(out[i]), `non-finite sample at ${i} for ${JSON.stringify(p)}`);
        assert(Math.abs(out[i]) <= 1.0001, `sample out of range: ${out[i]}`);
      }
    }
  });

  await check('pitch shifting moves F0 by the requested ratio', () => {
    for (const ratio of [1.6, 0.7]) {
      const { out, sr, latency } = runDsp({ pitch: ratio, formant: 1 });
      const f0 = measureF0(out, sr, latency + 8192);
      const got = f0 / 120;
      assert(Math.abs(got / ratio - 1) < 0.08,
        `asked x${ratio}, measured x${got.toFixed(3)} (${f0.toFixed(1)}Hz)`);
    }
  });

  /**
   * Spectral centroid over the speech band.
   *
   * Used instead of hunting for a formant peak. Peak-picking needs to be told
   * where to look and reports something confidently wrong when the peak is not
   * there; the centroid moves with the whole envelope, which is exactly the
   * quantity these two tests are about. Verified against the offline harness:
   * a x1.16 formant setting moves it x1.15, and a pitch-only shift leaves it
   * within 3%.
   */
  const centroid = (x, sr, from, lo = 200, hi = 6000) => {
    const N = 4096;
    const f = new FFT(N);
    let num = 0;
    let den = 0;
    for (let w = 0; w < 6; w++) {
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      const at = from + w * (N / 2);
      for (let i = 0; i < N; i++) {
        re[i] = x[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        im[i] = 0;
      }
      f.forward(re, im);
      const binHz = sr / N;
      for (let k = Math.round(lo / binHz); k <= Math.round(hi / binHz); k++) {
        const m = Math.hypot(re[k], im[k]);
        num += k * binHz * m;
        den += m;
      }
    }
    return den > 0 ? num / den : 0;
  };

  await check('pitch shifting alone leaves the formants where they were', () => {
    // The chipmunk test, and the reason this module exists at all: a naive
    // shifter drags the vocal-tract resonances up with the pitch, and every
    // listener hears that instantly. With formant at 1 they must not move.
    const dry = runDsp({ pitch: 1, formant: 1 });
    const up = runDsp({ pitch: 1.6, formant: 1 });
    const down = runDsp({ pitch: 0.7, formant: 1 });
    const a = centroid(dry.out, dry.sr, dry.latency + 8192);
    const b = centroid(up.out, up.sr, up.latency + 8192);
    const c = centroid(down.out, down.sr, down.latency + 8192);
    assert(b / a > 0.88 && b / a < 1.14,
      `x1.6 pitch moved the spectrum x${(b / a).toFixed(2)} - formants are tracking pitch`);
    assert(c / a > 0.88 && c / a < 1.14,
      `x0.7 pitch moved the spectrum x${(c / a).toFixed(2)} - formants are tracking pitch`);
    return `centroid x${(b / a).toFixed(2)} up, x${(c / a).toFixed(2)} down`;
  });

  await check('formant shifting moves the spectrum by its own ratio', () => {
    // The mirror of the test above: proves it is capable of failing rather
    // than being satisfied by any input at all.
    const dry = runDsp({ pitch: 1, formant: 1 });
    const a = centroid(dry.out, dry.sr, dry.latency + 8192);
    for (const ratio of [1.4, 0.75]) {
      const wet = runDsp({ pitch: 1, formant: ratio });
      const got = centroid(wet.out, wet.sr, wet.latency + 8192) / a;
      assert(Math.abs(got / ratio - 1) < 0.22,
        `asked for formant x${ratio}, spectrum moved x${got.toFixed(2)}`);
    }
  });

  await check('silence in, silence out', () => {
    // A phone call is mostly silence. NaN here would not be a quiet call, it
    // would be a dead one: a single non-finite sample poisons the encoder.
    const vc = new VoiceChanger(48000);
    vc.setParams({ pitch: 1.62, formant: 1.16 });
    const n = 24000;
    const out = new Float32Array(n);
    vc.process(new Float32Array(n), out);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      assert(Number.isFinite(out[i]), `non-finite sample at ${i}`);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    assert(peak < 1e-6, `silence produced ${peak}`);
  });

  await check('survives odd block sizes and a mid-call parameter change', () => {
    // AudioWorklet delivers 128 frames, but nothing in the DSP may depend on
    // that, and the Settings sliders retune the processor while it runs.
    const vc = new VoiceChanger(48000);
    const n = 30000;
    const inp = new Float32Array(n);
    for (let i = 0; i < n; i++) inp[i] = 0.4 * Math.sin((2 * Math.PI * 140 * i) / 48000);
    const out = new Float32Array(n);
    const sizes = [1, 7, 113, 257, 64, 999];
    let i = 0;
    let k = 0;
    while (i < n) {
      const len = Math.min(sizes[k++ % sizes.length], n - i);
      if (k % 5 === 0) vc.setParams({ pitch: 0.7 + (k % 7) * 0.15, formant: 0.9 + (k % 3) * 0.1 });
      vc.process(inp.subarray(i, i + len), out.subarray(i, i + len));
      i += len;
    }
    for (let j = 0; j < n; j++) assert(Number.isFinite(out[j]), `non-finite at ${j}`);
  });

  await check('reset clears state, so one call cannot bleed into the next', () => {
    const vc = new VoiceChanger(48000);
    vc.setParams({ pitch: 1.62, formant: 1.16 });
    const n = 20000;
    const inp = new Float32Array(n);
    for (let i = 0; i < n; i++) inp[i] = 0.4 * Math.sin((2 * Math.PI * 130 * i) / 48000);
    const run = () => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 128) {
        const len = Math.min(128, n - i);
        vc.process(inp.subarray(i, i + len), out.subarray(i, i + len));
      }
      return out;
    };
    const a = run();
    vc.reset();
    const b = run();
    let d = 0;
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    assert(d < 1e-5, `output differed by ${d} after reset`);
  });

  await check('every preset keeps formants far closer to 1 than pitch', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      if (name === 'off') continue;
      const pitchAway = Math.abs(Math.log(p.pitch));
      const formantAway = Math.abs(Math.log(p.formant));
      assert(formantAway < pitchAway,
        `preset "${name}" moves formants (x${p.formant}) as much as pitch (x${p.pitch})`);
    }
  });

  await check('the worklet module loads in the real renderer', async () => {
    // Catches the bundle being stale or missing, which no unit test would:
    // the DSP is bundled separately because an AudioWorklet cannot import.
    const ctx = new AudioContext({ sampleRate: 48000 });
    try {
      // Resolved against the page (src/index.html), like the dynamic imports above.
      await ctx.audioWorklet.addModule('../vendor/voice-worklet.js');
      const node = new AudioWorkletNode(ctx, 'voice-changer', { outputChannelCount: [1] });
      assert(node, 'node was not created');
      node.disconnect();
      return 'registered as "voice-changer"';
    } finally {
      await ctx.close();
    }
  });

  await check('voicefx reports its configuration back', () => {
    const before = voicefx.getConfig();
    const c = voicefx.configure({ enabled: true, pitch: 1.5, formant: 1.1 });
    assert(c.enabled === true && c.pitch === 1.5 && c.formant === 1.1, 'config did not stick');
    voicefx.configure(before);
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
