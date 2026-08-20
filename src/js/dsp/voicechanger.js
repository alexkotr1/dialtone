/**
 * Real-time voice transformation for a phone call.
 *
 * The thing that makes a voice changer sound like a voice changer is that
 * naive pitch shifting moves the formants along with the pitch. Formants are
 * resonances of the vocal tract, and their positions encode the SIZE of the
 * speaker's head and throat. Shift them and you do not sound like a different
 * person, you sound like the same person inhaling helium, or a cartoon
 * villain. Every listener recognises that instantly.
 *
 * So pitch and formants move independently here:
 *
 *   pitch   - where the harmonics sit (how high the voice reads)
 *   formant - where the resonances sit (how large the speaker reads)
 *
 * A convincing lower-to-higher change is roughly pitch x1.6 with formants
 * only x1.15: the voice goes up a lot, the apparent body size goes up a
 * little. Moving both by the same factor is what produces a chipmunk.
 *
 * Method: STFT phase vocoder. Each frame is split into a spectral envelope
 * (the formants, via cepstral liftering) and an excitation (the harmonics,
 * from dividing the envelope out). The excitation is pitch-shifted, the
 * envelope is warped separately, and the two are multiplied back together.
 *
 * Three things beyond the textbook version, each removing a specific audible
 * tell:
 *
 *   Phase locking   - a plain phase vocoder advances every bin independently,
 *                     which destroys the phase relationships within a single
 *                     harmonic and produces the loose, underwater "phasiness"
 *                     that is the second-biggest giveaway after formants.
 *                     Bins are locked to their peak instead.
 *
 *   Transient reset - overlap-add smears plosives, turning every "p" and "t"
 *                     into a soft thud. On a detected transient the synthesis
 *                     phases are reset to the analysis phases, keeping the
 *                     attack intact.
 *
 *   Voicing gate    - phase locking assumes harmonics. Applied to a fricative
 *                     it invents tonal structure in what should be noise, and
 *                     "s" begins to whistle. Locking fades out when unvoiced.
 *
 * Runs on the audio thread. Everything is preallocated; `process` must not
 * allocate, because a garbage collection here is an audible click.
 */

import { FFT } from './fft.js';

const TWO_PI = Math.PI * 2;

/** How far above its own spectral envelope one bin is allowed to be. */
const EXCITATION_CEILING = 20;

/** Wrap to (-pi, pi]. Called per bin per frame, so no loop. */
function wrapPhase(x) {
  let q = x * (1 / TWO_PI);
  q = q - Math.round(q);
  return q * TWO_PI;
}

export const PRESETS = {
  off: { pitch: 1.0, formant: 1.0, brightness: 0, label: 'Off' },
  // Ratios come from measured adult speech: a typical male F0 is ~110Hz and a
  // typical female ~200Hz (x1.8), but vocal tract length differs by only
  // ~13% (x1.15 in formants). Using the pitch ratio for both is the mistake
  // that makes every free voice changer sound like a toy.
  higherSoft: { pitch: 1.42, formant: 1.1, brightness: 0.1, label: 'Higher, soft' },
  higher: { pitch: 1.62, formant: 1.16, brightness: 0.14, label: 'Higher' },
  lowerSoft: { pitch: 0.8, formant: 0.93, brightness: -0.06, label: 'Lower, soft' },
  lower: { pitch: 0.66, formant: 0.87, brightness: -0.1, label: 'Lower' },
  // Same apparent size of speaker, different pitch: reads as the same kind of
  // person with a cold, rather than as an obviously transformed voice. The
  // most useful setting if the goal is simply not to be recognised.
  disguise: { pitch: 0.86, formant: 1.06, brightness: 0.04, label: 'Subtle disguise' },
};

export class VoiceChanger {
  /**
   * @param {number} sampleRate
   * @param {object} [opts]
   * @param {number} [opts.fftSize] power of two. 2048 at 48k gives 23Hz bins,
   *   enough to separate the harmonics of a low voice (~100Hz spacing). 1024
   *   halves the latency but smears those harmonics together.
   * @param {number} [opts.overlap] analysis frames per window.
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    // Defaults chosen by measurement, not taste - see tools/voicelab.
    //   2048  23Hz bins. At 1024 the harmonics of a 120Hz voice fall inside
    //         one bin and HNR collapses by 13dB; at 4096 latency doubles to
    //         85ms for no measured gain.
    //   4     75% overlap. Higher overlap costs CPU linearly and measured no
    //         better; 8 and 16 were both slightly WORSE on HNR.
    const N = opts.fftSize || 2048;
    const overlap = opts.overlap || 4;
    this.fftSize = N;
    this.hop = Math.floor(N / overlap);
    this.half = N >> 1;

    this.fft = new FFT(N);

    this.lockEnabled = opts.lock !== false;
    // Fraction of the pitch period used as the cepstral lifter cutoff.
    // The single most sensitive constant here. Too low and the envelope is too
    // coarse, so formants only partly move and a requested x1.16 lands at
    // x1.02. Too high and the envelope starts capturing the HARMONICS, the
    // excitation goes flat, and the pitch shift quietly stops happening - at
    // 0.45 the downward preset measured a 16% pitch error because of exactly
    // that. 0.20 was the best measured compromise across both directions.
    this.lifterFactor = opts.lifterFactor || 0.2;

    this.pitch = 1;
    this.formant = 1;
    this.brightness = 0;
    this.mix = 1;

    // Hann, applied on both analysis and synthesis. With 75%+ overlap the
    // squared window sums to a constant, so overlap-add is transparent.
    this.window = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    }
    let wsum = 0;
    for (let i = 0; i < N; i += this.hop) wsum += this.window[i] * this.window[i];
    this.windowNorm = 1 / (wsum || 1);

    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.mag = new Float32Array(this.half + 1);
    this.phase = new Float32Array(this.half + 1);
    this.lastPhase = new Float32Array(this.half + 1);
    this.sumPhase = new Float32Array(this.half + 1);
    this.trueBin = new Float32Array(this.half + 1);
    this.env = new Float32Array(this.half + 1);
    this.warpedEnv = new Float32Array(this.half + 1);
    this.exc = new Float32Array(this.half + 1);
    this.synMag = new Float32Array(this.half + 1);
    this.synBin = new Float32Array(this.half + 1);
    this.srcBin = new Int32Array(this.half + 1);
    this.prevMag = new Float32Array(this.half + 1);
    this.outPhase = new Float32Array(this.half + 1);

    this.cepRe = new Float32Array(N);
    this.cepIm = new Float32Array(N);
    this.acRe = new Float32Array(N);
    this.acIm = new Float32Array(N);

    // The lifter cutoff separates formant structure from harmonic ripple in
    // the log spectrum. Formants vary on a ~1kHz scale, so quefrencies below
    // sampleRate/1000 capture them; the ripple of even an 80Hz voice sits far
    // above, at sampleRate/80.
    this.lifter = Math.max(16, Math.round(sampleRate / 1000));
    // Never let the lifter reach far enough to resolve individual harmonics of
    // even a fairly low voice; beyond this the "envelope" starts tracking the
    // pitch and the two stop being separable at all.
    this.maxLifter = Math.round(sampleRate / 220);
    // Sensible default until the first voiced frame measures a real one.
    this.period = Math.round(sampleRate / 150);

    // Quefrency range searched for the pitch peak: 60Hz to 400Hz.
    this.qMin = Math.floor(sampleRate / 400);
    this.qMax = Math.min(N >> 1, Math.floor(sampleRate / 60));

    this.inBuf = new Float32Array(N);
    this.inCount = 0;
    this.outAccum = new Float32Array(N * 2);
    const fifo = N * 4;
    this.outFifo = new Float32Array(fifo);
    this.outRead = 0;
    this.outWrite = 0;
    this.outAvail = 0;

    // Dry path, delayed to match the wet one so `mix` crossfades two aligned
    // signals instead of producing a flanged mess.
    this.latency = N;
    this.dry = new Float32Array(fifo);
    this.dryWrite = 0;

    this.flux = 0;
    this.fluxAvg = 0;
    this.voicing = 0;
    this.sinceTransient = 99;
    /** Set by the offline harness to record per-frame decisions. */
    this.onFrame = null;

    this.reset();
  }

  reset() {
    this.inBuf.fill(0);
    this.inCount = 0;
    this.outAccum.fill(0);
    this.outFifo.fill(0);
    this.dry.fill(0);
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.prevMag.fill(0);
    this.outRead = 0;
    this.dryWrite = 0;
    // Prime with exactly the algorithmic latency, so the first `process` has
    // something to return and the stream never underruns afterwards.
    this.outAvail = this.latency;
    this.outWrite = this.latency;
    this.flux = 0;
    this.fluxAvg = 0;
    this.voicing = 0;
    this.sinceTransient = 99;
  }

  /** @param {{pitch?:number, formant?:number, brightness?:number, mix?:number}} p */
  setParams(p) {
    if (p.pitch != null) this.pitch = Math.min(2.5, Math.max(0.4, p.pitch));
    if (p.formant != null) this.formant = Math.min(2.0, Math.max(0.5, p.formant));
    if (p.brightness != null) this.brightness = Math.min(1, Math.max(-1, p.brightness));
    if (p.mix != null) this.mix = Math.min(1, Math.max(0, p.mix));
  }

  /** True when the settings are a no-op, so callers can skip the graph. */
  isBypass() {
    return this.pitch === 1 && this.formant === 1 && this.brightness === 0;
  }

  /**
   * @param {Float32Array} input
   * @param {Float32Array} output same length as input; may alias input
   */
  process(input, output) {
    const n = input.length;
    let i = 0;
    while (i < n) {
      const take = Math.min(this.fftSize - this.inCount, n - i);
      for (let k = 0; k < take; k++) {
        const s = input[i + k];
        this.inBuf[this.inCount + k] = s;
        this.dry[this.dryWrite] = s;
        this.dryWrite = (this.dryWrite + 1) % this.dry.length;
      }
      this.inCount += take;
      i += take;

      if (this.inCount === this.fftSize) {
        this._frame();
        for (let k = 0; k < this.hop; k++) {
          this.outFifo[this.outWrite] = this.outAccum[k];
          this.outWrite = (this.outWrite + 1) % this.outFifo.length;
        }
        this.outAvail += this.hop;
        this.outAccum.copyWithin(0, this.hop);
        this.outAccum.fill(0, this.outAccum.length - this.hop);
        this.inBuf.copyWithin(0, this.hop);
        this.inCount = this.fftSize - this.hop;
      }
    }

    const wet = this.mix;
    const dryGain = 1 - wet;
    const dlen = this.dry.length;
    let dryRead = ((this.dryWrite - this.latency - n) % dlen + dlen) % dlen;
    for (let k = 0; k < n; k++) {
      let s = 0;
      if (this.outAvail > 0) {
        s = this.outFifo[this.outRead];
        this.outRead = (this.outRead + 1) % this.outFifo.length;
        this.outAvail--;
      }
      if (dryGain > 0) s = s * wet + this.dry[dryRead] * dryGain;
      dryRead = (dryRead + 1) % dlen;
      // Soft clip. Processing can add a few dB of peak, and a hard clip on a
      // phone call is far more noticeable than a little compression.
      output[k] = s > 1 ? 1 : s < -1 ? -1 : s - (s * s * s) / 6;
    }
  }

  _frame() {
    const N = this.fftSize;
    const half = this.half;
    const re = this.re;
    const im = this.im;

    for (let k = 0; k < N; k++) {
      re[k] = this.inBuf[k] * this.window[k];
      im[k] = 0;
    }
    this.fft.forward(re, im);

    let flux = 0;
    for (let k = 0; k <= half; k++) {
      const r = re[k];
      const j = im[k];
      const m = Math.sqrt(r * r + j * j);
      this.mag[k] = m;
      this.phase[k] = Math.atan2(j, r);
      const d = m - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = m;
    }

    // Transient: a jump in spectral flux relative to its own recent average.
    // Relative rather than absolute, so it tracks the speaker's level.
    // Transient detection, deliberately reluctant.
    //
    // A false positive is expensive: the reset below throws away the phase
    // coherence that locking spent the previous frames establishing, so it has
    // to buy a genuine attack to be worth it. The first threshold (2.2x) fired
    // four to five times inside every SUSTAINED VOWEL in the test set, where
    // the correct answer is zero, and each of those is a glitch in the middle
    // of a held note. Two changes: a higher bar, and a hold-off so one attack
    // cannot re-trigger on its own decay a frame later.
    this.fluxAvg = this.fluxAvg * 0.9 + flux * 0.1;
    const loud = this.fluxAvg > 1e-6 && flux > this.fluxAvg * 3.5;
    const transient = loud && this.sinceTransient >= 3;
    this.sinceTransient = transient ? 0 : this.sinceTransient + 1;

    this._measureVoicing();
    this._envelope();

    // Whiten, so the pitch shift moves only harmonics.
    //
    // The divisor is floored relative to the loudest part of the envelope, not
    // by a tiny absolute epsilon. In a deep spectral valley - the gap between
    // F1 and F2 of an /i/, say - the envelope is near zero, and dividing by it
    // turns whatever noise sits in that valley into a full-scale excitation
    // that then gets pitch-shifted around like a real harmonic. That vowel was
    // measuring 7-9dB of HNR loss against 0-4dB for the others, which is the
    // shape of an artefact confined to one spectrum, not general roughness.
    let envMax = 0;
    for (let k = 0; k <= half; k++) if (this.env[k] > envMax) envMax = this.env[k];
    const envFloor = envMax * 1e-3 + 1e-12;
    for (let k = 0; k <= half; k++) {
      const e = this.env[k];
      let x = this.mag[k] / (e > envFloor ? e : envFloor);
      // Bound the whitening.
      //
      // Where the envelope fits, the excitation is the harmonic fine
      // structure: peaks a few times the envelope, valleys below it. A ratio
      // of twenty means the envelope did not fit - a steep rolloff it could
      // not follow, or a near-empty region of the spectrum - and dividing by
      // that near-zero envelope manufactures an excitation far louder than
      // anything really there. Pitch-shifting then moves that invented energy
      // somewhere audible: on a test tone with a sharp low-frequency rolloff
      // it relocated the whole spectrum, turning a 960Hz resonance into a
      // 390Hz one while the formant setting was 1.0 and nothing should have
      // moved at all.
      if (x > EXCITATION_CEILING) x = EXCITATION_CEILING;
      this.exc[k] = x;
    }

    // True per-bin frequency, from the phase advance between frames.
    const expected = (TWO_PI * this.hop) / N;
    const binsPerRad = N / (TWO_PI * this.hop);
    for (let k = 0; k <= half; k++) {
      const p = this.phase[k];
      let d = p - this.lastPhase[k];
      this.lastPhase[k] = p;
      d -= k * expected;
      d = wrapPhase(d);
      this.trueBin[k] = k + d * binsPerRad;
    }

    // Resample the excitation spectrum onto the synthesis bins.
    //
    // Pulling each output bin from where it came (j -> j/pitch) rather than
    // pushing each input bin to where it goes (k -> k*pitch). The push version
    // is the textbook one and it collapses when shifting DOWN: round(k*0.66)
    // sends two or three analysis bins to the same synthesis bin, which piles
    // their magnitudes into one place and keeps only the last frequency
    // estimate. Measured on a downward shift, that turned a 2.5ms plosive into
    // a 13ms thud and put enough tonal structure into a fricative to drop its
    // spectral flatness by half - an "s" that whistles. Pulling touches every
    // output bin exactly once, so neither can happen.
    // Pitch-shift only what actually has a pitch.
    //
    // A fricative is noise: it has formants but no F0, so "shift its pitch" is
    // not a meaningful instruction. Resampling its excitation anyway aliases
    // the noise into irregular peaks - measured as a 65% collapse in spectral
    // flatness on an /s/, which is audible as a whistle and is one of the
    // clearest tells that a voice is being processed. The vocal tract still
    // shapes a fricative, so the ENVELOPE warp below must still apply; it is
    // only the harmonic shift that has to stand down. Same reasoning rescues
    // plosives, which are broadband clicks with no periodicity either.
    const pitch = 1 + (this.pitch - 1) * this.voicing;
    const inv = 1 / pitch;
    this.synMag.fill(0);
    this.synBin.fill(0);
    this.srcBin.fill(-1);
    // Straight interpolation in both directions.
    //
    // Taking the strongest source bin in each output bin's span looks like the
    // right anti-aliasing move when shifting down, and is not: it replicates
    // one peak across the several output bins that overlap it, so the comb
    // smears instead of moving and the pitch shift stops happening altogether
    // (measured: 102% pitch error). Reading the value AT j/pitch is what
    // actually relocates a harmonic.
    for (let j = 0; j <= half; j++) {
      const src = j * inv;
      const k0 = Math.floor(src);
      if (k0 < 0 || k0 > half) continue;
      const k1 = k0 + 1 <= half ? k0 + 1 : k0;
      const frac = src - k0;
      this.synMag[j] = this.exc[k0] * (1 - frac) + this.exc[k1] * frac;
      this.synBin[j] = (this.trueBin[k0] * (1 - frac) + this.trueBin[k1] * frac) * pitch;
      this.srcBin[j] = frac < 0.5 ? k0 : k1;
    }

    this._warpEnvelope();

    for (let j = 0; j <= half; j++) {
      this.sumPhase[j] = wrapPhase(this.sumPhase[j] + this.synBin[j] * expected);
      this.outPhase[j] = this.sumPhase[j];
    }

    if (transient) {
      for (let j = 0; j <= half; j++) {
        const k = this.srcBin[j];
        if (k >= 0) this.outPhase[j] = this.phase[k];
        this.sumPhase[j] = this.outPhase[j];
      }
    } else if (this.lockEnabled && this.voicing > 0.15) {
      this._lockPhases();
    }

    const tilt = this.brightness;
    for (let j = 0; j <= half; j++) {
      let m = this.synMag[j] * this.warpedEnv[j];
      if (tilt !== 0) {
        // Gentle spectral tilt. A raised larynx brightens a voice slightly;
        // this is what keeps a pitched-up voice from merely sounding small.
        const f = j / half;
        m *= 1 + tilt * (f - 0.35);
        if (m < 0) m = 0;
      }
      const ph = this.outPhase[j];
      re[j] = m * Math.cos(ph);
      im[j] = m * Math.sin(ph);
    }
    im[0] = 0;
    im[half] = 0;
    for (let j = half + 1; j < N; j++) {
      re[j] = re[N - j];
      im[j] = -im[N - j];
    }

    this.fft.inverse(re, im);

    const norm = this.windowNorm;
    for (let k = 0; k < N; k++) {
      this.outAccum[k] += re[k] * this.window[k] * norm;
    }

    if (this.onFrame) this.onFrame(this.voicing, transient, pitch);
  }

  /**
   * How periodic this frame is, 0..1, by normalised autocorrelation.
   *
   * Autocorrelation rather than the cepstral peak this used to use. Scoring a
   * cepstral peak against the MEAN of its neighbours looks reasonable and is
   * badly wrong: the maximum of a few hundred noisy samples sits three or four
   * times their mean purely by extreme-value statistics, so white noise scored
   * as fully voiced and every unvoiced protection downstream was dead code.
   * The normalised autocorrelation peak has a fixed, interpretable scale
   * instead - it is the fraction of the frame that repeats at some lag, which
   * is 0 for noise no matter how long you look.
   *
   * Costs one inverse FFT: the autocorrelation is the transform of the power
   * spectrum, and the magnitudes are already computed.
   */
  _measureVoicing() {
    const N = this.fftSize;
    const half = this.half;
    const ar = this.acRe;
    const ai = this.acIm;

    for (let k = 0; k <= half; k++) {
      const m = this.mag[k];
      ar[k] = m * m;
      ai[k] = 0;
    }
    for (let k = half + 1; k < N; k++) {
      ar[k] = ar[N - k];
      ai[k] = 0;
    }
    this.fft.inverse(ar, ai);

    const r0 = ar[0];
    let v = 0;
    if (r0 > 1e-12) {
      let peak = 0;
      let peakLag = 0;
      for (let q = this.qMin; q <= this.qMax; q++) {
        if (ar[q] > peak) { peak = ar[q]; peakLag = q; }
      }
      const nac = peak / r0;
      // A clean vowel sits above 0.6; broadband noise stays under 0.2.
      v = Math.min(1, Math.max(0, (nac - 0.22) / 0.33));
      if (v > 0.3 && peakLag > 0) this.period = peakLag;
    }
    this.voicing = this.voicing * 0.55 + v * 0.45;
  }

  /**
   * Spectral envelope by cepstral liftering.
   *
   * The log spectrum of voiced speech is a smooth formant curve with harmonic
   * ripple on top. Those sit at different quefrencies, so a low-pass in the
   * cepstral domain separates them - and the height of the peak being
   * discarded is exactly how periodic the frame is, which is the voicing
   * measure. One transform, both answers.
   */
  _envelope() {
    const N = this.fftSize;
    const half = this.half;
    const cr = this.cepRe;
    const ci = this.cepIm;

    for (let k = 0; k <= half; k++) {
      cr[k] = Math.log(this.mag[k] + 1e-9);
      ci[k] = 0;
    }
    for (let k = half + 1; k < N; k++) {
      cr[k] = cr[N - k];
      ci[k] = 0;
    }
    this.fft.inverse(cr, ci);

    // Lifter cutoff from the measured pitch period, not a fixed constant.
    //
    // The cutoff has to sit below the harmonic ripple (which lives at
    // quefrency = period) and as far above it as possible, because everything
    // the envelope fails to capture is left behind in the excitation - at the
    // ORIGINAL formant positions. Warping the envelope then moves only part of
    // the formant structure and the rest stays put, so the output lands
    // between the two. Measured: a requested x1.16 formant shift achieving
    // only x1.02-1.09 with a fixed cutoff of sampleRate/1000.
    //
    // A fixed cutoff cannot win. Set low enough for a 300Hz voice it is far
    // too coarse for a 100Hz one; set for the 100Hz voice it swallows the
    // harmonics of the 300Hz one and the pitch leaks into the envelope.
    const cut = Math.max(
      16,
      Math.min(this.maxLifter, Math.round(this.period * this.lifterFactor)),
    );
    this.lifter = cut;
    for (let q = cut; q <= N - cut; q++) cr[q] = 0;
    ci.fill(0);
    this.fft.forward(cr, ci);

    for (let k = 0; k <= half; k++) {
      this.env[k] = Math.exp(cr[k]);
    }
  }

  /** Move the formants by `formant`, independently of the pitch. */
  _warpEnvelope() {
    const half = this.half;
    const r = this.formant;
    if (r === 1) {
      this.warpedEnv.set(this.env);
      return;
    }
    for (let j = 0; j <= half; j++) {
      const src = j / r;
      const i0 = Math.floor(src);
      if (i0 >= half) {
        // Past the top of the source spectrum. Hold the last value rather
        // than fall to zero, which would carve a hole in the top octave.
        this.warpedEnv[j] = this.env[half];
      } else {
        const frac = src - i0;
        this.warpedEnv[j] = this.env[i0] * (1 - frac) + this.env[i0 + 1] * frac;
      }
    }
  }

  /**
   * Identity phase locking (Laroche and Dolson).
   *
   * A harmonic occupies several bins. Advancing each independently - what a
   * plain phase vocoder does - lets them drift out of step, and the result is
   * the loose, reverberant, slightly underwater quality that makes a pitch
   * shifter audible even when the pitch itself is correct. Locking each bin
   * to its peak, preserving the offset it had on input, keeps the harmonic
   * rigid.
   */
  _lockPhases() {
    const half = this.half;
    const mag = this.synMag;
    const strength = Math.min(1, (this.voicing - 0.15) / 0.35);

    let p = 0;
    while (p <= half) {
      let peak = -1;
      for (let j = p; j <= half; j++) {
        const m = mag[j];
        if (m <= 0) continue;
        const l1 = j > 0 ? mag[j - 1] : 0;
        const r1 = j < half ? mag[j + 1] : 0;
        if (m > l1 && m >= r1) {
          peak = j;
          break;
        }
      }
      if (peak < 0) break;

      let next = -1;
      for (let j = peak + 2; j <= half; j++) {
        const m = mag[j];
        if (m <= 0) continue;
        const l1 = mag[j - 1];
        const r1 = j < half ? mag[j + 1] : 0;
        if (m > l1 && m >= r1) {
          next = j;
          break;
        }
      }
      const end = next < 0 ? half : Math.floor((peak + next) / 2);

      const kp = this.srcBin[peak];
      if (kp >= 0) {
        const peakPhase = this.sumPhase[peak];
        const peakSrcPhase = this.phase[kp];
        for (let j = p; j <= end; j++) {
          if (j === peak) continue;
          const k = this.srcBin[j];
          if (k < 0) continue;
          const locked = peakPhase + (this.phase[k] - peakSrcPhase);
          const d = wrapPhase(locked - this.outPhase[j]);
          this.outPhase[j] = this.outPhase[j] + d * strength;
        }
      }
      p = end + 1;
      if (next < 0) break;
    }
  }
}
