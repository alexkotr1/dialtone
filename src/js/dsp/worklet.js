/**
 * AudioWorklet wrapper around the voice changer.
 *
 * Bundled to vendor/voice-worklet.js by `npm run build:worklet`, because an
 * AudioWorklet module is loaded as a CLASSIC script - `import` is a syntax
 * error inside AudioWorkletGlobalScope - so the DSP has to be inlined. Same
 * reason and same tool as the JsSIP vendor bundle.
 *
 * Everything here runs on the audio thread, on a 128-sample deadline. No
 * allocation, no logging, no message passing per block: a missed deadline is a
 * dropout the far end hears as a click.
 */

import { VoiceChanger } from './voicechanger.js';

class VoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // `sampleRate` is a global in AudioWorkletGlobalScope, and is the context
    // rate rather than the microphone's - which is the rate that matters,
    // since the graph has already resampled by the time audio arrives here.
    this.vc = new VoiceChanger(sampleRate, opts);
    if (opts.params) this.vc.setParams(opts.params);

    // Capture mode: hand the raw input to the main thread and emit silence.
    // Used by the Settings preview, which records first and plays back after,
    // so it must not put anything into the speakers while it listens.
    this.capture = !!opts.capture;
    // Batched, because one message per 128-sample block is 375 postMessage
    // calls a second and they are not free on the audio thread.
    this.batch = this.capture ? new Float32Array(4096) : null;
    this.batchAt = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'params') this.vc.setParams(d.params || {});
      else if (d.type === 'reset') this.vc.reset();
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh = output[0];
    if (!input || input.length === 0 || !input[0]) {
      // The source is not producing yet. Emit silence rather than returning
      // false, which would tear the node down permanently.
      outCh.fill(0);
      return true;
    }

    if (this.capture) {
      const src = input[0];
      for (let i = 0; i < src.length; i++) {
        this.batch[this.batchAt++] = src[i];
        if (this.batchAt === this.batch.length) {
          this.port.postMessage({ type: 'block', data: this.batch.slice(0) });
          this.batchAt = 0;
        }
      }
      outCh.fill(0);
      return true;
    }

    this.vc.process(input[0], outCh);

    // Mono in, mono out; copy to any further channels so a stereo sink does
    // not end up with one silent side.
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}

registerProcessor('voice-changer', VoiceProcessor);
