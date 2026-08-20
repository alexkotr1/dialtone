/**
 * Run the voice changer over a WAV file, offline.
 *
 * The DSP is deliberately a plain module with no Web Audio dependency, so the
 * exact code that runs on the audio thread can be measured here against known
 * input. Testing a voice changer by listening to it in the app is how you ship
 * something that sounds fine to the person who tuned it.
 *
 * Feeds audio in 128-sample blocks, which is the AudioWorklet quantum, so the
 * buffering and FIFO behaviour under test is the behaviour in production.
 *
 *   node run_dsp.mjs in.wav out.wav --pitch 1.6 --formant 1.15 [--fft 2048]
 */

import fs from 'node:fs';
import { VoiceChanger } from '../../src/js/dsp/voicechanger.js';

function readWav(path) {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.bits !== 16) throw new Error(`only 16-bit supported, got ${fmt.bits}`);
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Mix to mono; the call path is mono anyway.
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2);
    out[i] = acc / fmt.channels / 32768;
  }
  return { sampleRate: fmt.sampleRate, samples: out };
}

function writeWav(path, sampleRate, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path, buf);
}

const args = process.argv.slice(2);
const inPath = args[0];
const outPath = args[1];
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};

const { sampleRate, samples } = readWav(inPath);
const vc = new VoiceChanger(sampleRate, {
  fftSize: flag('fft', 2048),
  overlap: flag('overlap', 8),
  lock: !args.includes('--nolock'),
  lifterFactor: flag('lifterFactor', 0.3),
});
vc.setParams({
  pitch: flag('pitch', 1),
  formant: flag('formant', 1),
  brightness: flag('brightness', 0),
  mix: flag('mix', 1),
});

// Record what the detector decided, per frame, so voicing can be checked
// against segments whose nature is known rather than assumed.
const frames = [];
if (args.includes('--frames')) {
  vc.onFrame = (voicing, transient, pitch) => frames.push({ voicing, transient, pitch });
}

const out = new Float32Array(samples.length);
const BLOCK = 128;
const t0 = process.hrtime.bigint();
for (let i = 0; i < samples.length; i += BLOCK) {
  const len = Math.min(BLOCK, samples.length - i);
  vc.process(samples.subarray(i, i + len), out.subarray(i, i + len));
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

let nonFinite = 0;
let peak = 0;
for (let i = 0; i < out.length; i++) {
  if (!Number.isFinite(out[i])) nonFinite++;
  else peak = Math.max(peak, Math.abs(out[i]));
}

writeWav(outPath, sampleRate, out);
const audioMs = (samples.length / sampleRate) * 1000;
console.log(JSON.stringify({
  file: outPath,
  seconds: +(samples.length / sampleRate).toFixed(2),
  cpuMs: +ms.toFixed(1),
  realtimeFactor: +(ms / audioMs).toFixed(4),
  latencySamples: vc.latency,
  latencyMs: +((vc.latency / sampleRate) * 1000).toFixed(1),
  peak: +peak.toFixed(3),
  nonFinite,
  frames: frames.length ? frames.map((f) => ({
    v: +f.voicing.toFixed(3), t: f.transient ? 1 : 0, p: +f.pitch.toFixed(3),
  })) : undefined,
}));
