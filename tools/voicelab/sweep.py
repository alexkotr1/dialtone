"""Run a matrix of DSP settings and rank them on the metrics that matter.

Tuning a voice changer by ear is how you end up with something that sounds
right to the one person who tuned it. This scores every configuration on the
same four numbers and prints them side by side, so a change has to justify
itself against the alternative rather than against a memory of the last take.

    python sweep.py --matrix quality
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "out"
SPEECH = OUT / "speech.wav"
META = OUT / "speech.json"


def run(tag, pitch, formant, **flags):
    dest = OUT / f"sw_{tag}.wav"
    cmd = [
        "node", str(HERE / "run_dsp.mjs"), str(SPEECH), str(dest),
        "--pitch", str(pitch), "--formant", str(formant),
    ]
    for k, v in flags.items():
        cmd += [f"--{k}", str(v)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])
    stats = json.loads(r.stdout.strip().splitlines()[-1])

    a = subprocess.run(
        [sys.executable, str(HERE / "analyze.py"), str(SPEECH), str(dest), str(META),
         "--pitch", str(pitch), "--formant", str(formant), "--json"],
        capture_output=True, text=True,
    )
    if a.returncode != 0:
        raise RuntimeError(a.stderr[-800:])
    rep = json.loads(a.stdout)

    hnr, perr, ferr, flat, atk = [], [], [], None, None
    for s in rep["segments"]:
        if "hnrDropDb" in s:
            hnr.append(s["hnrDropDb"])
            if s.get("pitchErrPct") is not None:
                perr.append(abs(s["pitchErrPct"]))
            if s.get("formantErrPct") is not None:
                ferr.append(abs(s["formantErrPct"]))
        if "flatnessDropPct" in s:
            flat = s["flatnessDropPct"]
        if "attackGrowth" in s:
            atk = s["attackGrowth"]
    return {
        "tag": tag,
        "cpuPct": round(stats["realtimeFactor"] * 100, 1),
        "latMs": stats["latencyMs"],
        "hnrDrop": round(float(np.mean(hnr)), 1) if hnr else None,
        "pitchErr": round(float(np.mean(perr)), 1) if perr else None,
        "formantErr": round(float(np.mean(ferr)), 1) if ferr else None,
        "flatDrop": flat,
        "attack": atk,
    }


def show(rows):
    print(f"{'config':<22}{'HNR drop':>9}{'pitch err':>10}{'fmt err':>9}"
          f"{'s-flat':>8}{'attack':>8}{'cpu':>7}{'lat':>7}")
    print("-" * 80)
    for r in sorted(rows, key=lambda x: (x["hnrDrop"] if x["hnrDrop"] is not None else 99)):
        print(f"{r['tag']:<22}{r['hnrDrop']:>8.1f}dB{r['pitchErr']:>9.1f}%"
              f"{r['formantErr']:>8.1f}%{r['flatDrop']:>7.1f}%{r['attack']:>8.2f}"
              f"{r['cpuPct']:>6.1f}%{r['latMs']:>6.0f}ms")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", default="quality")
    ap.add_argument("--pitch", type=float, default=1.62)
    ap.add_argument("--formant", type=float, default=1.16)
    args = ap.parse_args()

    rows = []
    if args.matrix == "quality":
        # Window length trades frequency resolution against latency, and
        # overlap trades smoothness against CPU. Both change how badly the
        # phase vocoder smears harmonics, which is what HNR drop measures.
        for fft in (1024, 2048, 4096):
            for ov in (4, 8, 16):
                rows.append(run(f"fft{fft}_ov{ov}", args.pitch, args.formant,
                                fft=fft, overlap=ov))
    show(rows)


if __name__ == "__main__":
    main()
