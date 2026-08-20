/**
 * Every sound the app makes, synthesised.
 *
 * No audio files: a dialpad tone is two sine waves and a ringtone is a short
 * motif, and generating them means the app has no assets to ship, no format
 * to worry about, and tones that are correct by construction rather than
 * correct because someone found the right WAV.
 *
 * All of it is local feedback for the person at this machine. None of it is
 * mixed into the call — the far end never hears any of this.
 */

let ctx = null;

/** The context is created on the first real gesture, because a context made
 *  before one starts suspended and every later sound is silently dropped. */
function audio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

/** The real dual-tone pair for a key, at a level that reads as feedback
 *  rather than as a telephone exchange in the room. */
export function playDtmf(key, ms = 120) {
  const pair = DTMF[key];
  if (!pair) return;
  const ac = audio();
  const gain = ac.createGain();
  gain.connect(ac.destination);
  const t = ac.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.09, t + 0.012);
  gain.gain.setValueAtTime(0.09, t + ms / 1000 - 0.02);
  // Ramped down rather than stopped dead: an abrupt cut is an audible click.
  gain.gain.linearRampToValueAtTime(0, t + ms / 1000);
  for (const f of pair) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }
}

/** A looping tone pattern, used for both ringback and the incoming ring. */
function loop({ notes, period, volume }) {
  const ac = audio();
  let stopped = false;
  let timer = null;

  const beat = () => {
    if (stopped) return;
    const t0 = ac.currentTime;
    for (const n of notes) {
      const gain = ac.createGain();
      gain.connect(ac.destination);
      const start = t0 + n.at;
      const end = start + n.dur;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.04);
      gain.gain.setValueAtTime(volume, end - 0.06);
      gain.gain.linearRampToValueAtTime(0, end);
      for (const f of n.freqs) {
        const osc = ac.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    }
    timer = setTimeout(beat, period);
  };

  beat();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** What you hear while the far end is ringing. The classic 440+480 Hz pair,
 *  two seconds on and four off. */
export function ringback() {
  return loop({
    notes: [{ at: 0, dur: 1.6, freqs: [440, 480] }],
    period: 5000,
    volume: 0.055,
  });
}

/** The incoming ring. Deliberately a soft rising motif rather than a
 *  telephone bell — this plays on a desktop where the person is a metre from
 *  the speakers, not across a room. */
export function ringtone() {
  return loop({
    notes: [
      { at: 0.0, dur: 0.22, freqs: [587.33] },
      { at: 0.26, dur: 0.22, freqs: [739.99] },
      { at: 0.52, dur: 0.42, freqs: [880.0] },
      { at: 1.1, dur: 0.22, freqs: [587.33] },
      { at: 1.36, dur: 0.22, freqs: [739.99] },
      { at: 1.62, dur: 0.42, freqs: [880.0] },
    ],
    period: 3400,
    volume: 0.07,
  });
}

/** Two short descending notes when the other side hangs up, so an ended call
 *  is audible without looking at the screen. */
export function endTone() {
  const ac = audio();
  const t = ac.currentTime;
  [[440, 0], [330, 0.13]].forEach(([f, at]) => {
    const gain = ac.createGain();
    gain.connect(ac.destination);
    gain.gain.setValueAtTime(0, t + at);
    gain.gain.linearRampToValueAtTime(0.06, t + at + 0.02);
    gain.gain.linearRampToValueAtTime(0, t + at + 0.14);
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t + at);
    osc.stop(t + at + 0.16);
  });
}

/**
 * Live input level from a device, as 0..1, for the meter in Settings.
 *
 * "Is this the right microphone?" is the question people actually have, and
 * a moving bar answers it in a second where a device name never does.
 * Returns a stop function; the caller must call it or the mic stays open.
 */
export async function meterMic(deviceId, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  const ac = audio();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  src.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // Speech RMS sits far below 1.0, so scale it into something that moves
    // visibly at ordinary talking volume.
    onLevel(Math.min(1, rms * 6));
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  };
}
