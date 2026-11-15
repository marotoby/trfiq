#!/usr/bin/env python3
"""Generate demo IQ recordings (standard library only, so it runs in a bare python image).

    python3 scripts/gen_samples.py OUT_DIR

Writes a handful of SigMF pairs in different datatypes, a raw rtl_sdr-style .cu8 file, and a
deliberately broken pair, covering every recording status the index knows about.
"""

import json
import math
import random
import sys
from array import array
from pathlib import Path

random.seed(7)
TAU = 2 * math.pi


def write(arr: array, path: Path):
    if sys.byteorder == "big":
        arr.byteswap()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        arr.tofile(f)


def meta(path: Path, datatype, sample_rate, freq, description, annotations=(), hw="trfiq sample generator"):
    doc = {
        "global": {
            "core:datatype": datatype,
            "core:sample_rate": sample_rate,
            "core:version": "1.2.0",
            "core:description": description,
            "core:author": "trfiq",
            "core:hw": hw,
        },
        "captures": [
            {"core:sample_start": 0, "core:frequency": freq, "core:datetime": "2026-11-15T12:00:00Z"}
        ],
        "annotations": list(annotations),
    }
    path.write_text(json.dumps(doc, indent=2))


def ann(start, count, f_lo, f_hi, label):
    return {
        "core:sample_start": start,
        "core:sample_count": count,
        "core:freq_lower_edge": f_lo,
        "core:freq_upper_edge": f_hi,
        "core:label": label,
    }


def fm_band(out: Path):
    """Three FM-modulated carriers plus noise. cf32_le."""
    sr, fc, n = 2.4e6, 98.0e6, 1 << 21
    carriers = [(-600e3, 0.30, 400.0), (150e3, 0.20, 900.0), (700e3, 0.08, 250.0)]
    phases = [0.0] * len(carriers)
    buf = array("f")
    for i in range(n):
        re = random.gauss(0, 0.004)
        im = random.gauss(0, 0.004)
        for k, (off, amp, tone) in enumerate(carriers):
            dev = 60e3 * math.sin(TAU * tone * i / sr)
            phases[k] += TAU * (off + dev) / sr
            re += amp * math.cos(phases[k])
            im += amp * math.sin(phases[k])
        buf.append(re)
        buf.append(im)
    write(buf, out / "demo/fm_band.sigmf-data")
    meta(
        out / "demo/fm_band.sigmf-meta",
        "cf32_le", sr, fc, "Three wideband FM carriers",
        [ann(0, n, fc + off - 100e3, fc + off + 100e3, "FM") for off, _, _ in carriers],
    )


def chirps(out: Path):
    """Repeating linear chirps sweeping ±400 kHz. ci16_le."""
    sr, fc, n = 1e6, 433.92e6, 1 << 20
    period = 50_000
    buf = array("h")
    ph = 0.0
    for i in range(n):
        t = (i % period) / period
        f = -400e3 + 800e3 * t
        ph += TAU * f / sr
        buf.append(int(12000 * math.cos(ph) + random.gauss(0, 150)))
        buf.append(int(12000 * math.sin(ph) + random.gauss(0, 150)))
    write(buf, out / "demo/chirps.sigmf-data")
    meta(out / "demo/chirps.sigmf-meta", "ci16_le", sr, fc, "Linear chirps, 50 ms period",
         [ann(0, n, fc - 400e3, fc + 400e3, "chirp")])


def bursts(out: Path):
    """Short tone bursts at random times/frequencies over noise. ci8. Exercises max-hold:
    bursts are shorter than the overview's row spacing, so a naive overview misses them."""
    sr, fc, n = 2e6, 915e6, 1 << 22
    events = []
    for _ in range(40):
        start = random.randrange(0, n - 4000)
        events.append((start, random.randint(300, 3000), random.uniform(-0.8, 0.8) * sr / 2))
    events.sort()
    buf = array("b", bytes(2 * n))
    for i in range(n):
        buf[2 * i] = max(-127, min(127, int(random.gauss(0, 3))))
        buf[2 * i + 1] = max(-127, min(127, int(random.gauss(0, 3))))
    annotations = []
    for start, length, off in events:
        for j in range(length):
            ph = TAU * off * j / sr
            k = start + j
            buf[2 * k] = max(-127, min(127, buf[2 * k] + int(90 * math.cos(ph))))
            buf[2 * k + 1] = max(-127, min(127, buf[2 * k + 1] + int(90 * math.sin(ph))))
        annotations.append(ann(start, length, fc + off - 5e3, fc + off + 5e3, "burst"))
    write(buf, out / "demo/bursts.sigmf-data")
    meta(out / "demo/bursts.sigmf-meta", "ci8", sr, fc, "40 short bursts", annotations)


def ism_annotated(out: Path):
    """433 MHz ISM band with several labelled signal types and precise annotations. ci16_le.

    Exercises the annotation overlay: overlapping times, very different bandwidths, and many
    small annotations (one per Morse letter)."""
    sr, fc, n = 1e6, 433.92e6, 1 << 21
    re = [random.gauss(0, 0.004) for _ in range(n)]
    im = [random.gauss(0, 0.004) for _ in range(n)]
    anns = []

    def add(start, freqs, amps):
        """Add a signal from per-sample frequency offsets (Hz) and amplitudes."""
        ph = random.uniform(0, TAU)
        for j, (f, a) in enumerate(zip(freqs, amps)):
            ph += TAU * f / sr
            if a:
                re[start + j] += a * math.cos(ph)
                im[start + j] += a * math.sin(ph)

    def at(t):
        return int(t * sr)

    def note(start, count, f_lo, f_hi, label, comment):
        a = ann(start, count, fc + f_lo, fc + f_hi, label)
        a["core:comment"] = comment
        anns.append(a)

    # OOK keyfob: PT2262-style frames, 300 us units, 4 repeats per press.
    unit = 300
    for t in (0.15, 0.95, 1.70):
        bits = [random.getrandbits(1) for _ in range(24)]
        amps = []
        for _ in range(4):
            for b in bits:
                amps += [0.25] * (3 * unit if b else unit) + [0.0] * (unit if b else 3 * unit)
            amps += [0.25] * unit + [0.0] * (31 * unit)
        start = at(t)
        add(start, [120e3] * len(amps), amps)
        code = "".join(map(str, bits))
        note(start, len(amps), 110e3, 130e3, "OOK keyfob", f"PT2262-style, 4 repeats, code {code}")

    # 2-FSK sensor packets: 20 kbit/s, +-25 kHz deviation, 512 bits.
    spb = 50
    for k, t in enumerate((0.05, 0.40, 0.75, 1.10, 1.45, 1.80)):
        bits = [i % 2 for i in range(64)] + [random.getrandbits(1) for _ in range(448)]
        freqs = [(-250e3 + (25e3 if b else -25e3)) for b in bits for _ in range(spb)]
        start = at(t)
        add(start, freqs, [0.12] * len(freqs))
        note(start, len(freqs), -280e3, -220e3, "2-FSK", f"Sensor packet {k + 1}: 20 kbit/s, 64-bit preamble")

    # LoRa-style CSS packets: SF7, 125 kHz bandwidth (1024 samples per symbol at 1 MS/s).
    bw, sym = 125e3, 1024
    for t in (0.30, 1.25):
        freqs = []
        symbols = [0] * 8 + [None, None] + [random.randrange(128) for _ in range(24)]
        for s in symbols:
            for j in range(sym):
                if s is None:  # downchirp (sync)
                    freqs.append(300e3 + bw / 2 - bw * j / sym)
                else:
                    freqs.append(300e3 - bw / 2 + bw * (((j / sym) + s / 128) % 1.0))
        start = at(t)
        add(start, freqs, [0.1] * len(freqs))
        note(start, len(freqs), 300e3 - bw / 2, 300e3 + bw / 2, "LoRa",
             "SF7 / 125 kHz: 8 upchirp preamble, 2 sync downchirps, 24 data symbols")

    # CW beacon sending TRFIQ in Morse, 40 ms dots; one annotation per letter.
    morse = {"T": "-", "R": ".-.", "F": "..-.", "I": "..", "Q": "--.-"}
    dot = at(0.04)
    pos = at(0.10)
    for letter in "TRFIQ":
        letter_start = pos
        for i, el in enumerate(morse[letter]):
            length = dot * (3 if el == "-" else 1)
            add(pos, [-400e3] * length, [0.03] * length)
            pos += length + (dot if i < len(morse[letter]) - 1 else 0)
        note(letter_start, pos - letter_start, -402e3, -398e3, "CW", f"Morse '{letter}' ({morse[letter]})")
        pos += 3 * dot

    # Sweep jammer: sawtooth -150..+50 kHz every 200 us, 20 ms bursts.
    for t in (0.60, 1.35, 1.95):
        length = at(0.02)
        freqs = [-150e3 + 200e3 * ((j % 200) / 200) for j in range(length)]
        start = at(t)
        add(start, freqs, [0.15] * length)
        note(start, length, -150e3, 50e3, "Sweep jammer", "200 kHz sawtooth sweep, 5 kHz repetition")

    anns.sort(key=lambda a: a["core:sample_start"])
    buf = array("h", (int(max(-32767, min(32767, v * 32767))) for pair in zip(re, im) for v in pair))
    write(buf, out / "demo/ism_433_annotated.sigmf-data")
    meta(out / "demo/ism_433_annotated.sigmf-meta", "ci16_le", sr, fc,
         "433 MHz ISM band: keyfob, FSK sensors, LoRa, CW beacon, jammer (annotated)", anns,
         hw="trfiq sample generator (simulated ISM band)")


def raw_rtl(out: Path):
    """rtl_sdr-style unsigned 8-bit capture with no metadata: indexed as 'needs metadata'."""
    sr, n = 2.048e6, 1 << 20
    buf = array("B")
    for i in range(n):
        ph = TAU * 250e3 * i / sr
        buf.append(max(0, min(255, int(127.5 + 60 * math.cos(ph) + random.gauss(0, 4)))))
        buf.append(max(0, min(255, int(127.5 + 60 * math.sin(ph) + random.gauss(0, 4)))))
    write(buf, out / "raw/rtl_capture.cu8")


def broken(out: Path):
    """A .sigmf-data with no .sigmf-meta: indexed as 'broken'."""
    write(array("f", [0.0] * 1024), out / "broken/orphan.sigmf-data")


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "samples")
    # Each generator is skipped if its output already exists, so this is safe to re-run.
    outputs = {
        fm_band: "demo/fm_band.sigmf-meta",
        chirps: "demo/chirps.sigmf-meta",
        bursts: "demo/bursts.sigmf-meta",
        ism_annotated: "demo/ism_433_annotated.sigmf-meta",
        raw_rtl: "raw/rtl_capture.cu8",
        broken: "broken/orphan.sigmf-data",
    }
    for fn, marker in outputs.items():
        if (out / marker).exists():
            continue
        print(f"generating {fn.__name__}…", flush=True)
        fn(out)
    print(f"done: {out}")


if __name__ == "__main__":
    main()
