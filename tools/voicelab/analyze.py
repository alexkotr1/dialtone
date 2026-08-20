"""Measure what the voice changer actually did, against what it claimed.

The question a voice changer has to answer is not "does it sound different" but
"does it sound like a person". Those come apart in measurable ways, and each
metric here corresponds to a specific way listeners detect processing:

  pitch ratio       did F0 move by the requested factor
  formant ratio     did the formants move by THEIR factor and not the pitch one
                    - this is the chipmunk test, and the single most important
                      number in the file
  HNR delta         harmonic-to-noise ratio. Phase vocoders leak energy between
                    harmonics; the ear hears that as roughness or breathiness
  flatness delta    on the fricative. Phase locking applied to noise invents
                    tonal structure, which is an "s" that whistles
  attack ratio      on the plosive. Overlap-add smears transients into thuds

    python analyze.py original.wav processed.wav original.json --pitch 1.6 --formant 1.15
"""

import argparse
import json

import numpy as np
from scipy.io import wavfile
from scipy.signal import decimate, lfilter


def load(path):
    sr, x = wavfile.read(path)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return sr, x.astype(np.float64) / 32768.0


def f0_autocorr(x, sr, lo=50, hi=500):
    """F0 by autocorrelation. Robust on sustained vowels, which is all we ask."""
    x = x - x.mean()
    if np.max(np.abs(x)) < 1e-6:
        return 0.0
    w = x * np.hanning(len(x))
    corr = np.correlate(w, w, mode="full")[len(w) - 1:]
    corr /= corr[0] + 1e-12
    lo_lag = int(sr / hi)
    hi_lag = min(int(sr / lo), len(corr) - 1)
    if hi_lag <= lo_lag:
        return 0.0
    seg = corr[lo_lag:hi_lag]
    k = int(np.argmax(seg))
    peak = seg[k]
    if peak < 0.25:
        return 0.0
    lag = lo_lag + k
    # Parabolic interpolation for sub-sample accuracy.
    if 0 < k < len(seg) - 1:
        a, b, c = seg[k - 1], seg[k], seg[k + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag += 0.5 * (a - c) / denom
    return sr / lag


def hnr(x, sr):
    """Harmonic-to-noise ratio in dB, from the autocorrelation peak."""
    x = x - x.mean()
    if np.max(np.abs(x)) < 1e-6:
        return -99.0
    w = x * np.hanning(len(x))
    corr = np.correlate(w, w, mode="full")[len(w) - 1:]
    corr /= corr[0] + 1e-12
    lo_lag, hi_lag = int(sr / 500), int(sr / 50)
    seg = corr[lo_lag:min(hi_lag, len(corr) - 1)]
    if len(seg) == 0:
        return -99.0
    r = float(np.clip(seg.max(), 1e-6, 0.999999))
    return 10 * np.log10(r / (1 - r))


def spectral_envelope(x, sr, nfft=2048):
    """Cepstrally-smoothed average log spectrum: formants without the harmonics.

    The same liftering the DSP uses. Averaging over frames first makes it
    steady enough to compare between two recordings.
    """
    hop = nfft // 4
    frames = []
    for i in range(0, max(1, len(x) - nfft), hop):
        seg = x[i:i + nfft]
        if len(seg) < nfft:
            break
        frames.append(np.abs(np.fft.rfft(seg * np.hanning(nfft))))
    if not frames:
        return None
    mag = np.mean(frames, axis=0) + 1e-12
    logmag = np.log(mag)
    # Real cepstrum: inverse transform of the log magnitude, treated as a
    # zero-phase spectrum. (Doing rfft-then-irfft here instead is a no-op that
    # returns the log spectrum unchanged, so the lifter below removes nothing
    # and every comparison comes back as "no shift" - which is exactly the bug
    # this line replaces.)
    cep = np.fft.irfft(logmag)
    cut = max(16, int(round(sr / 250)))
    cep[cut:len(cep) - cut] = 0
    smooth = np.fft.rfft(cep).real
    return smooth[:len(logmag)]


def envelope_shift_ratio(xa, xb, sr, lo=200, hi=8000):
    """How far the spectral envelope moved, as a frequency ratio.

    Formant identification by LPC roots is fragile: it returns a different
    NUMBER of poles for two takes of the same vowel, so pairing them up
    compares F2 against F3 and reports a shift that never happened. That is
    exactly what it did on the bypass case, where the true answer is 1.000.

    A shift of the formants by ratio r is a pure TRANSLATION of the envelope
    on a log-frequency axis, by log(r). So resample both envelopes onto a log
    axis and cross-correlate. No formants have to be identified, nothing has
    to be paired, and the answer degrades gracefully instead of catastrophically
    when the fit is poor.
    """
    ea, eb = spectral_envelope(xa, sr), spectral_envelope(xb, sr)
    if ea is None or eb is None:
        return None
    freqs = np.fft.rfftfreq((len(ea) - 1) * 2, 1 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    if band.sum() < 32:
        return None

    # Uniform grid in log-frequency.
    M = 1024
    grid = np.exp(np.linspace(np.log(lo), np.log(hi), M))
    va = np.interp(grid, freqs[band], ea[band])
    vb = np.interp(grid, freqs[band], eb[band])

    # Detrend before correlating. A voice spectrum is formant bumps riding a
    # steep source tilt (roughly -12dB/octave), and that tilt is identical in
    # both signals whatever the formants did. Left in, it dominates the
    # correlation and pins the answer at zero lag - the measurement then reads
    # "no shift" for every input, including shifts it was handed deliberately.
    # Only the bumps carry the formant information, so fit the slow trend away.
    axis = np.linspace(-1, 1, M)
    for v in (va, vb):
        coef = np.polyfit(axis, v, 3)
        v -= np.polyval(coef, axis)
    if np.std(va) < 1e-9 or np.std(vb) < 1e-9:
        return None
    va = va / np.std(va)
    vb = vb / np.std(vb)

    cc = np.correlate(vb, va, mode="full")
    lags = np.arange(-M + 1, M)
    # A formant ratio outside 0.5..2.0 is not a plausible voice.
    dlog = (np.log(hi) - np.log(lo)) / (M - 1)
    limit = int(np.log(2.0) / dlog)
    keep = np.abs(lags) <= limit
    cc, lags = cc[keep], lags[keep]
    k = int(np.argmax(cc))
    lag = float(lags[k])
    if 0 < k < len(cc) - 1:
        a_, b_, c_ = cc[k - 1], cc[k], cc[k + 1]
        d = a_ - 2 * b_ + c_
        if abs(d) > 1e-12:
            lag += 0.5 * (a_ - c_) / d
    return float(np.exp(lag * dlog))


def f0_track(x, sr, win=0.045, hop=0.015):
    """Frame-wise F0. A single autocorrelation over a whole segment reports
    nonsense when the pitch is moving, which is what the sweep is for."""
    n, h = int(win * sr), int(hop * sr)
    out = []
    for i in range(0, max(1, len(x) - n), h):
        f = f0_autocorr(x[i:i + n], sr)
        if f > 0:
            out.append(f)
    return np.array(out)


def spectral_flatness(x):
    """Geometric over arithmetic mean of the spectrum. 1.0 = noise, 0 = tonal.

    Used on the fricative: if processing pushes this DOWN, tonal structure has
    been invented where there should be none, and that is an audible whistle.
    """
    if np.max(np.abs(x)) < 1e-6:
        return 0.0
    s = np.abs(np.fft.rfft(x * np.hanning(len(x)))) + 1e-12
    return float(np.exp(np.mean(np.log(s))) / np.mean(s))


def attack_sharpness(x, sr):
    """Rise time of the loudest transient, in ms. Smearing makes this grow."""
    env = np.abs(x)
    win = int(0.001 * sr)
    env = np.convolve(env, np.ones(win) / win, mode="same")
    if env.max() < 1e-6:
        return 0.0
    peak = int(np.argmax(env))
    thresh = env[peak] * 0.2
    i = peak
    while i > 0 and env[i] > thresh:
        i -= 1
    return (peak - i) / sr * 1000


def align(a, b, sr, max_ms=120):
    """Latency of b relative to a, by cross-correlation."""
    n = min(len(a), len(b), sr * 2)
    lim = int(max_ms / 1000 * sr)
    fa = np.fft.rfft(a[:n] - a[:n].mean(), n * 2)
    fb = np.fft.rfft(b[:n] - b[:n].mean(), n * 2)
    cc = np.fft.irfft(fb * np.conj(fa))[:lim]
    return int(np.argmax(cc))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("original")
    ap.add_argument("processed")
    ap.add_argument("meta")
    ap.add_argument("--pitch", type=float, default=1.0)
    ap.add_argument("--formant", type=float, default=1.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    sr, a = load(args.original)
    sr2, b = load(args.processed)
    assert sr == sr2, "sample rates differ"
    meta = json.load(open(args.meta))

    lag = align(a, b, sr)
    report = {"latencySamples": lag, "latencyMs": round(lag / sr * 1000, 1), "segments": []}

    for seg in meta["segments"]:
        s = int(seg["start"] * sr)
        e = int(seg["end"] * sr)
        # Trim edges: window ramps at a segment boundary are not the signal.
        pad = int(0.06 * sr)
        xa = a[s + pad:e - pad]
        xb = b[s + pad + lag:e - pad + lag]
        if len(xb) < sr // 10:
            continue

        row = {"name": seg["name"]}

        if seg.get("unvoiced"):
            fa_, fb_ = spectral_flatness(xa), spectral_flatness(xb)
            row["flatnessIn"] = round(fa_, 4)
            row["flatnessOut"] = round(fb_, 4)
            row["flatnessDropPct"] = round((1 - fb_ / (fa_ + 1e-12)) * 100, 1)
        elif seg.get("transient"):
            row["attackInMs"] = round(attack_sharpness(xa, sr), 2)
            row["attackOutMs"] = round(attack_sharpness(xb, sr), 2)
            row["attackGrowth"] = round(
                attack_sharpness(xb, sr) / (attack_sharpness(xa, sr) + 1e-9), 2)
        else:
            ta, tb = f0_track(xa, sr), f0_track(xb, sr)
            # Compare medians of the tracks rather than one measurement over
            # the whole segment, so a gliding pitch is handled correctly.
            f0a = float(np.median(ta)) if len(ta) else 0.0
            f0b = float(np.median(tb)) if len(tb) else 0.0
            row["f0In"] = round(f0a, 1)
            row["f0Out"] = round(f0b, 1)
            row["pitchRatio"] = round(f0b / f0a, 3) if f0a > 0 else None
            row["pitchErrPct"] = (
                round((f0b / f0a / args.pitch - 1) * 100, 1) if f0a > 0 and args.pitch else None
            )
            fr = envelope_shift_ratio(xa, xb, sr)
            if fr:
                row["formantRatio"] = round(fr, 3)
                row["formantErrPct"] = round((fr / args.formant - 1) * 100, 1)
            row["hnrInDb"] = round(hnr(xa, sr), 1)
            row["hnrOutDb"] = round(hnr(xb, sr), 1)
            row["hnrDropDb"] = round(hnr(xa, sr) - hnr(xb, sr), 1)

        report["segments"].append(row)

    if args.json:
        print(json.dumps(report, indent=2))
        return

    print(f"latency: {report['latencyMs']} ms ({lag} samples)")
    print(f"{'segment':<12} {'pitch':>16} {'formant':>16} {'HNR drop':>9}")
    for r in report["segments"]:
        if "pitchRatio" in r:
            p = f"{r['f0In']}->{r['f0Out']} x{r['pitchRatio']}"
            fr = r.get("formantRatio")
            fstr = f"x{fr} ({r.get('formantErrPct'):+.1f}%)" if fr else "-"
            print(f"{r['name']:<12} {p:>16} {fstr:>16} {r['hnrDropDb']:>8.1f}dB")
        elif "flatnessDropPct" in r:
            print(f"{r['name']:<12} flatness {r['flatnessIn']:.3f}->{r['flatnessOut']:.3f} "
                  f"(drop {r['flatnessDropPct']}%)")
        elif "attackInMs" in r:
            print(f"{r['name']:<12} attack {r['attackInMs']}ms->{r['attackOutMs']}ms "
                  f"(x{r['attackGrowth']})")


if __name__ == "__main__":
    main()
