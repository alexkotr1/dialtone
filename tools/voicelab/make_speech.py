"""Synthesise test speech whose pitch and formants are known exactly.

Real recordings are useless for measuring a voice changer: you cannot say by
how much a formant moved if you never knew where it started. A source-filter
synthesis gives ground truth by construction - the glottal source sets F0, the
resonator cascade sets F1..F4 - so the analyser can check the transform did
precisely what it claimed rather than merely "something".

Covers the four cases that break pitch shifters in different ways:

  vowels     - the main event; formants must hold still while pitch moves
  fricative  - noise, no harmonics; phase locking wants to make it whistle
  plosive    - a transient; overlap-add wants to smear it into a thud
  sweep      - moving F0; catches a pitch tracker that only works when steady

    python make_speech.py out.wav
"""

import json
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import lfilter

SR = 48000

# Neutral adult-male vowels (Peterson & Barney averages, Hz).
VOWELS = {
    "a": [730, 1090, 2440, 3350],
    "i": [270, 2290, 3010, 3700],
    "u": [300, 870, 2240, 3350],
}
BANDWIDTHS = [60, 90, 120, 180]
F0 = 120.0


def resonator(x, freq, bw, sr=SR):
    """One two-pole formant resonator."""
    r = np.exp(-np.pi * bw / sr)
    theta = 2 * np.pi * freq / sr
    a = [1.0, -2 * r * np.cos(theta), r * r]
    # Normalise so the peak has unit gain rather than blowing up at low freq.
    b = [(1 - r) * np.sqrt(1 - 2 * r * np.cos(2 * theta) + r * r)]
    return lfilter(b, a, x)


def glottal_source(n, f0, sr=SR, jitter=0.01, shimmer=0.04, seed=0):
    """Rosenberg-style pulse train with the micro-variation real voices have.

    Perfectly periodic excitation is the one thing that never occurs in a human
    voice, and a processor tuned against it can look clean while sounding
    synthetic on a real speaker.
    """
    rng = np.random.default_rng(seed)
    out = np.zeros(n)
    t = 0.0
    while t < n:
        period = sr / f0 * (1 + rng.normal(0, jitter))
        amp = 1.0 + rng.normal(0, shimmer)
        start = int(t)
        length = max(4, int(period * 0.6))
        if start + length >= n:
            break
        # Rosenberg glottal pulse: rising then a faster fall.
        k = np.arange(length) / length
        pulse = np.where(k < 0.6, 3 * (k / 0.6) ** 2 - 2 * (k / 0.6) ** 3,
                         1 - ((k - 0.6) / 0.4) ** 2)
        out[start:start + length] += amp * pulse
        t += period
    # Differentiate: the radiation characteristic at the lips is +6dB/octave.
    return np.diff(out, prepend=0.0)


def vowel(dur, formants, f0=F0, seed=0):
    n = int(dur * SR)
    x = glottal_source(n, f0, seed=seed)
    for f, bw in zip(formants, BANDWIDTHS):
        x = resonator(x, f, bw)
    return x


def sweep(dur, f_lo, f_hi, formants, seed=0):
    """A vowel whose F0 glides, as in real intonation."""
    n = int(dur * SR)
    rng = np.random.default_rng(seed)
    out = np.zeros(n)
    t = 0.0
    while t < n:
        frac = t / n
        f0 = f_lo * (f_hi / f_lo) ** frac
        period = SR / f0 * (1 + rng.normal(0, 0.01))
        start = int(t)
        length = max(4, int(period * 0.6))
        if start + length >= n:
            break
        k = np.arange(length) / length
        pulse = np.where(k < 0.6, 3 * (k / 0.6) ** 2 - 2 * (k / 0.6) ** 3,
                         1 - ((k - 0.6) / 0.4) ** 2)
        out[start:start + length] += pulse
        t += period
    out = np.diff(out, prepend=0.0)
    for f, bw in zip(formants, BANDWIDTHS):
        out = resonator(out, f, bw)
    return out


def fricative(dur, seed=1):
    """An /s/: shaped noise, energy well above the formant range."""
    n = int(dur * SR)
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 1, n)
    x = resonator(x, 5500, 900)
    x = resonator(x, 7500, 1200)
    return x


def plosive(dur, seed=2):
    """A /t/: silence, a sharp burst, then a short aspiration."""
    n = int(dur * SR)
    rng = np.random.default_rng(seed)
    out = np.zeros(n)
    burst = int(0.004 * SR)
    at = int(n * 0.4)
    out[at:at + burst] = rng.normal(0, 1, burst)
    asp = int(0.03 * SR)
    tail = rng.normal(0, 0.25, asp) * np.exp(-np.linspace(0, 4, asp))
    out[at + burst:at + burst + asp] += tail
    return resonator(out, 3000, 1500)


def main(path):
    parts = []
    marks = []
    pos = 0

    def add(name, sig, meta=None):
        nonlocal pos
        sig = sig / (np.max(np.abs(sig)) + 1e-9) * 0.6
        parts.append(sig)
        marks.append({
            "name": name,
            "start": pos / SR,
            "end": (pos + len(sig)) / SR,
            **(meta or {}),
        })
        pos += len(sig)
        gap = np.zeros(int(0.08 * SR))
        parts.append(gap)
        pos += len(gap)

    for i, (name, fs) in enumerate(VOWELS.items()):
        add(f"vowel_{name}", vowel(0.7, fs, seed=i), {"f0": F0, "formants": fs})
    add("sweep", sweep(0.7, 95, 165, VOWELS["a"]), {"f0_range": [95, 165]})
    add("fricative", fricative(0.4), {"unvoiced": True})
    add("plosive", plosive(0.4), {"transient": True})

    audio = np.concatenate(parts)
    wavfile.write(path, SR, (audio * 32767).astype(np.int16))
    with open(path.replace(".wav", ".json"), "w") as fh:
        json.dump({"sampleRate": SR, "segments": marks}, fh, indent=2)
    print(f"wrote {path}  {len(audio)/SR:.2f}s  {len(marks)} segments")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "speech.wav")
