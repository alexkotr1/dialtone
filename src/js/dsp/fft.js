/**
 * Iterative radix-2 complex FFT.
 *
 * Written out rather than pulled from npm because this runs inside an
 * AudioWorklet, where a module is loaded by URL into a separate realm with no
 * bundler and no `require`. A dependency here would have to be vendored and
 * flattened anyway, and the whole thing is sixty lines.
 *
 * Everything is preallocated in the constructor. `forward`/`inverse` allocate
 * nothing, because they run on the audio thread roughly 190 times a second and
 * a garbage collection there is an audible click.
 */

export class FFT {
  /** @param {number} size power of two */
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size);

    // Twiddle factors, computed once. cos/sin of 2*pi*k/size for k < size/2.
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    // Bit-reversal permutation table.
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** In-place forward transform of interleaved-free split arrays. */
  forward(re, im) {
    this._transform(re, im);
  }

  /**
   * In-place inverse, scaled by 1/N so that inverse(forward(x)) === x.
   *
   * Implemented by conjugating, running the forward transform and conjugating
   * back — one code path to get right instead of two.
   */
  inverse(re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this._transform(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] = -im[i] * inv;
    }
  }

  _transform(re, im) {
    const n = this.size;
    const rev = this.rev;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const wr = this.cos[k];
          const wi = this.sin[k];
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}
