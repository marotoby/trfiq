#!/usr/bin/env python3
"""Generate DSP golden fixtures for crates/dsp/tests/golden.rs.

Reference: numpy decode + scipy windows + numpy FFT, all in float64. Run from the repo root:

    python3 scripts/gen_golden.py
"""

import json
from pathlib import Path

import numpy as np
from scipy.signal import get_window

OUT = Path(__file__).resolve().parent.parent / "crates/dsp/tests/golden"
N = 512
RNG = np.random.default_rng(1234)

# datatype -> (numpy dtype, scale, offset)
TYPES = {
    "cf64_le": ("<f8", 1.0, 0.0),
    "cf32_le": ("<f4", 1.0, 0.0),
    "cf32_be": (">f4", 1.0, 0.0),
    "ci32_le": ("<i4", 2.0**31, 0.0),
    "ci16_le": ("<i2", 2.0**15, 0.0),
    "ci16_be": (">i2", 2.0**15, 0.0),
    "ci8": ("i1", 2.0**7, 0.0),
    "cu16_le": ("<u2", 2.0**15, 32767.5),
    "cu8": ("u1", 2.0**7, 127.5),
    "rf32_le": ("<f4", 1.0, 0.0),
    "ri16_le": ("<i2", 2.0**15, 0.0),
}
WINDOWS = {"hann": "hann", "blackman-harris": "blackmanharris", "rect": "boxcar"}


def make_raw(dt: str, npdt: str, scale: float, offset: float) -> bytes:
    complex_ = dt.startswith("c")
    count = N * (2 if complex_ else 1)
    # A tone plus noise at ~half scale, expressed in the native integer/float domain.
    t = np.arange(N)
    tone = 0.5 * np.exp(2j * np.pi * 37.25 * t / N)
    noise = 0.05 * (RNG.standard_normal(N) + 1j * RNG.standard_normal(N))
    x = tone + noise
    vals = np.empty(count)
    if complex_:
        vals[0::2], vals[1::2] = x.real, x.imag
    else:
        vals[:] = x.real
    native = vals * scale + offset
    if np.dtype(npdt).kind in "iu":
        info = np.iinfo(npdt)
        native = np.clip(np.round(native), info.min, info.max)
    return native.astype(npdt).tobytes()


def reference_db(raw: bytes, dt: str, npdt: str, scale: float, offset: float, win: str):
    v = (np.frombuffer(raw, dtype=npdt).astype(np.float64) - offset) / scale
    x = v[0::2] + 1j * v[1::2] if dt.startswith("c") else v.astype(np.complex128)
    w = get_window(WINDOWS[win], N, fftbins=True)
    X = np.fft.fftshift(np.fft.fft(x * w))
    p = np.abs(X) ** 2 / np.sum(w) ** 2
    return 10 * np.log10(p + 1e-30)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cases = []
    for dt, (npdt, scale, offset) in TYPES.items():
        raw = make_raw(dt, npdt, scale, offset)
        (OUT / f"{dt}.bin").write_bytes(raw)
        for win in WINDOWS:
            db = reference_db(raw, dt, npdt, scale, offset, win)
            name = f"{dt}.{win}.expected.f32"
            (OUT / name).write_bytes(db.astype("<f4").tobytes())
            cases.append({"datatype": dt, "window": win, "input": f"{dt}.bin", "expected": name})
    (OUT / "cases.json").write_text(json.dumps({"fft_size": N, "cases": cases}, indent=1))
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
