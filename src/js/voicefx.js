/**
 * The microphone capture path, with optional voice transformation.
 *
 * Owns a small Web Audio graph:
 *
 *     getUserMedia -> MediaStreamSource -> voice-changer worklet
 *                  -> MediaStreamDestination -> JsSIP
 *
 * The processed stream is built BEFORE the call is placed rather than swapped
 * in afterwards with replaceTrack(). Swapping is less invasive and was the
 * first design, but it means the first few hundred milliseconds go out
 * untransformed - on an answered incoming call that is the far end hearing the
 * real voice say "hello". If the feature is worth having at all, it cannot
 * have a hole at the start of every call.
 *
 * When the transform is off this returns the microphone stream untouched, so
 * the default path has no worklet, no extra graph and no added latency.
 */

const WORKLET_URL = '../../vendor/voice-worklet.js';

let ctx = null;
let workletReady = null;
let active = null; // { raw, source, node, dest }

/** Current settings. Mirrors what Settings writes into the store. */
let config = { enabled: false, pitch: 1, formant: 1, brightness: 0, mix: 1 };

/** True when the settings would leave the audio unchanged. */
function isNoop(c = config) {
  return !c.enabled || (c.pitch === 1 && c.formant === 1 && c.brightness === 0);
}

export function getConfig() {
  return { ...config };
}

/**
 * Update the transform. Safe to call mid-call: the worklet takes new
 * parameters over its message port without rebuilding the graph, so a slider
 * moves the voice live instead of dropping the call audio.
 *
 * Turning it on or off mid-call cannot be done this way - that changes the
 * graph shape, not a parameter - so it takes effect on the next call.
 */
export function configure(next) {
  config = { ...config, ...next };
  if (active && active.node) {
    active.node.port.postMessage({ type: 'params', params: params() });
  }
  return getConfig();
}

function params() {
  return {
    pitch: config.pitch,
    formant: config.formant,
    brightness: config.brightness,
    mix: config.enabled ? config.mix : 0,
  };
}

async function ensureWorklet() {
  if (!ctx) {
    // The mic is 48k on every device this runs on, and forcing the rate keeps
    // the DSP's frequency-resolution assumptions honest rather than leaving
    // them to whatever the default device offers.
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') await ctx.resume();
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule(new URL(WORKLET_URL, import.meta.url));
  }
  await workletReady;
  return ctx;
}

/**
 * Open the microphone and return the stream to send.
 *
 * @param {MediaStreamConstraints} constraints
 * @returns {Promise<MediaStream>}
 */
export async function capture(constraints) {
  release();
  const raw = await navigator.mediaDevices.getUserMedia(constraints);

  if (isNoop()) {
    active = { raw, source: null, node: null, dest: null };
    return raw;
  }

  try {
    const audio = await ensureWorklet();
    const source = audio.createMediaStreamSource(raw);
    const node = new AudioWorkletNode(audio, 'voice-changer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { params: params() },
    });
    const dest = audio.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);
    active = { raw, source, node, dest };
    return dest.stream;
  } catch (err) {
    // A failed transform must not become a failed call. Fall back to the
    // untouched microphone and let the caller decide whether to complain -
    // the person is on the phone either way, and silence would be worse than
    // an untransformed voice.
    active = { raw, source: null, node: null, dest: null };
    if (typeof console !== 'undefined') {
      console.warn('Voice transform unavailable, sending the raw microphone:', err);
    }
    return raw;
  }
}

/** True when the last capture actually went through the transform. */
export function isTransforming() {
  return !!(active && active.node);
}

/**
 * Record a few seconds from the microphone and play it back transformed.
 *
 * Record-then-play rather than a live monitor. A monitor is more immediate and
 * is what you reach for first, but it puts the microphone and the speakers in
 * the same room in an open loop - the howl arrives before the demonstration
 * does. This also happens to be the honest test, since it plays back the exact
 * bytes the far end would have received.
 *
 * @param {object} o
 * @param {number} [o.seconds]
 * @param {string} [o.deviceId]
 * @param {(phase: 'recording'|'playing'|'done') => void} [o.onPhase]
 * @returns {Promise<void>}
 */
export async function preview({ seconds = 3, deviceId = '', onPhase } = {}) {
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
  const raw = await navigator.mediaDevices.getUserMedia(constraints);
  const audio = await ensureWorklet();
  try {
    onPhase?.('recording');
    const source = audio.createMediaStreamSource(raw);
    const chunks = [];
    // A capture node with no output: it hands blocks to the main thread and
    // emits nothing, so nothing reaches the speakers while recording.
    const grabber = new AudioWorkletNode(audio, 'voice-changer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { params: { pitch: 1, formant: 1, brightness: 0, mix: 1 }, capture: true },
    });
    grabber.port.onmessage = (e) => {
      if (e.data && e.data.type === 'block') chunks.push(e.data.data);
    };
    source.connect(grabber);
    // Not connected to the destination: recording must stay silent.
    await new Promise((r) => setTimeout(r, seconds * 1000));
    source.disconnect();
    grabber.disconnect();
    grabber.port.onmessage = null;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (!total) return;
    const dry = new Float32Array(total);
    let at = 0;
    for (const c of chunks) {
      dry.set(c, at);
      at += c.length;
    }

    // Run the same DSP the call path uses, offline.
    const { VoiceChanger } = await import('./dsp/voicechanger.js');
    const vc = new VoiceChanger(audio.sampleRate);
    vc.setParams(params());
    const wet = new Float32Array(total);
    const BLOCK = 128;
    for (let i = 0; i < total; i += BLOCK) {
      const n = Math.min(BLOCK, total - i);
      vc.process(dry.subarray(i, i + n), wet.subarray(i, i + n));
    }

    onPhase?.('playing');
    const buf = audio.createBuffer(1, total, audio.sampleRate);
    buf.copyToChannel(wet, 0);
    await new Promise((resolve) => {
      const src = audio.createBufferSource();
      src.buffer = buf;
      src.connect(audio.destination);
      src.onended = resolve;
      src.start();
    });
  } finally {
    raw.getTracks().forEach((t) => t.stop());
    onPhase?.('done');
  }
}

/** Tear down the graph and close the microphone. */
export function release() {
  if (!active) return;
  const { raw, source, node, dest } = active;
  try {
    if (source) source.disconnect();
    if (node) node.disconnect();
    if (dest) dest.stream.getTracks().forEach((t) => t.stop());
    // JsSIP only stops tracks it opened itself, and this stream was handed to
    // it ready-made - so nothing else will turn the microphone light off.
    if (raw) raw.getTracks().forEach((t) => t.stop());
  } catch {
    // Teardown races a closing call; nothing here is worth failing over.
  }
  active = null;
}
