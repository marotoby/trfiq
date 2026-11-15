#!/usr/bin/env python3
"""Generate the T-RF/IQ logo and app mark as self-contained SVGs (no fonts, no external refs).

    python3 scripts/gen_logo.py

Writes docs/images/logo.svg (wide banner), docs/images/mark.svg and web/public/favicon.svg.
Letters are geometric paths, so the logo renders identically everywhere (GitHub included).
"""

import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
random.seed(42)

CYAN = "#22d3ee"
CYAN_2 = "#38bdf8"
BG = "#050a17"


# ---- colormap ----------------------------------------------------------------------------

def turbo(t: float) -> str:
    t = min(1.0, max(0.0, t))
    def poly(c):
        acc = 0.0
        for k in reversed(c):
            acc = acc * t + k
        return min(1.0, max(0.0, acc))
    r = poly([0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943])
    g = poly([0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604])
    b = poly([0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973])
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


# ---- letters (cap height 120, origin top-left, drawn upright; italicised by a skew) --------

GLYPHS = {
    # name: (advance width, path)
    "T": (104, "M0 0H104V26H65V120H39V26H0Z"),
    "-": (46, "M0 52H46V74H0Z"),
    "R": (108, "M0 0H68C94 0 106 16 106 37C106 55 96 67 80 71L108 120H78L54 75H26V120H0Z"
               "M26 23V53H66C76 53 80 46 80 38C80 29 76 23 66 23Z"),
    "F": (98, "M0 0H98V25H26V49H86V73H26V120H0Z"),
    "/": (84, "M58 0H84L26 120H0Z"),
    "I": (26, "M0 0H26V120H0Z"),
    "Q": (124, "M40 0H78C102 0 118 16 118 40V80C118 92 114 102 107 109L124 126H92L86 120H40"
               "C16 120 0 104 0 80V40C0 16 16 0 40 0Z"
               "M44 24C32 24 26 30 26 42V78C26 90 32 96 44 96H66L58 88H86L92 94V42C92 30 86 24 74 24Z"),
}
GAP = {"T": 8, "-": 8, "R": 8, "F": 2, "/": 2, "I": 12, "Q": 0}


def word(text: str, x: float, y: float, scale: float, fills: list[str], skew=-13) -> tuple[str, float]:
    """Return SVG for `text` with per-glyph fills, and the total width."""
    parts, cx = [], 0.0
    for ch, fill in zip(text, fills):
        adv, d = GLYPHS[ch]
        parts.append(f'<path transform="translate({cx:.1f} 0)" d="{d}" fill="{fill}" fill-rule="evenodd"/>')
        cx += adv + GAP[ch]
    g = (f'<g transform="translate({x} {y}) scale({scale}) skewX({skew})">'
         + "".join(parts) + "</g>")
    return g, cx * scale


# ---- banner ------------------------------------------------------------------------------

def banner() -> str:
    W, H = 1200, 360
    # Frame: slanted, rounded. Waterfall + trace sit along its bottom edge.
    frame = "M318 92H1088Q1136 92 1124 136L1084 284Q1074 318 1036 318H128"
    strip_top, strip_bot, x0, x1 = 262, 316, 120, 1010

    # Waterfall: noise floor + bright columns lined up with the trace's peaks.
    peaks = [(250, 1.0, 11), (402, 0.7, 9), (560, 0.4, 6), (668, 0.85, 10), (800, 0.65, 8), (925, 0.8, 9)]
    cols, rows = 200, 12
    cw, rh = (x1 - x0) / cols, (strip_bot - strip_top) / rows
    cells = []
    for c in range(cols):
        xc = x0 + (c + 0.5) * cw
        col_level = sum(a * math.exp(-((xc - px) / w) ** 2) for px, a, w in peaks)
        for r in range(rows):
            # Deep-blue floor, faint vertical texture, bright columns topping out at yellow/orange.
            texture = 0.06 * math.sin(c * 1.7) ** 8
            v = 0.07 + 0.11 * random.random() + texture + col_level * (0.52 + 0.2 * random.random())
            if random.random() < 0.04:
                v += 0.18  # sparkle
            v = min(v, 0.8)
            cells.append(f'<rect x="{x0 + c * cw:.2f}" y="{strip_top + r * rh:.2f}" '
                         f'width="{cw + 0.6:.2f}" height="{rh + 0.6:.2f}" fill="{turbo(v)}"/>')

    # Spectrum trace: noise + peaks, rising from the left like the arcs' base.
    pts = []
    for i in range(0, 461):
        x = 100 + i * 2
        base = 262 - 16 * math.exp(-((x - 100) / 150) ** 2)  # swell under the arcs
        y = base - 2.2 * math.sin(x * 0.21) - 1.4 * math.sin(x * 0.53 + 1)
        for px, a, w in peaks:
            y -= a * 100 * math.exp(-((x - px) / (w * 1.1)) ** 2) * (1 if px == 250 else 0.5)
        pts.append(f"{x},{y:.1f}")
    trace = "M" + " L".join(pts)

    # Broadcast arcs around the tallest peak.
    arcs = []
    cx, cy = 250, 214
    for i, rad in enumerate([36, 66, 96, 126]):
        a0, a1 = math.radians(205), math.radians(58)
        sx, sy = cx + rad * math.cos(a0), cy - rad * math.sin(a0)
        ex, ey = cx + rad * math.cos(a1), cy - rad * math.sin(a1)
        sw = 12 - i * 1.4
        arcs.append(f'<path d="M{sx:.1f} {sy:.1f}A{rad} {rad} 0 0 1 {ex:.1f} {ey:.1f}" '
                    f'stroke="url(#arc)" stroke-width="{sw}" stroke-linecap="round" fill="none" '
                    f'opacity="{1 - i * 0.12:.2f}"/>')

    text, tw = word("T-RF/IQ", 0, 0, 1.08, ["url(#white)"] * 5 + ["url(#cyan)"] * 2)
    tx = 1058 - tw
    text = text.replace("translate(0 0)", f"translate({tx:.1f} 112)", 1)

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="T-RF/IQ">
  <title>T-RF/IQ</title>
  <defs>
    <linearGradient id="arc" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="{CYAN}" stop-opacity="0.15"/>
      <stop offset="0.45" stop-color="{CYAN_2}"/>
      <stop offset="1" stop-color="#7dd3fc"/>
    </linearGradient>
    <linearGradient id="white" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#cfd9ea"/>
    </linearGradient>
    <linearGradient id="cyan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#67e8f9"/>
      <stop offset="0.55" stop-color="{CYAN}"/>
      <stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient>
    <linearGradient id="fadeX" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.12" stop-color="#fff" stop-opacity="0.9"/>
      <stop offset="0.85" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.2"/>
    </linearGradient>
    <radialGradient id="bgGlow" cx="0.3" cy="0.4" r="0.8">
      <stop offset="0" stop-color="#0c2440"/>
      <stop offset="1" stop-color="{BG}"/>
    </radialGradient>
    <mask id="stripMask"><rect x="{x0}" y="{strip_top}" width="{x1 - x0}" height="{strip_bot - strip_top}" fill="url(#fadeX)"/></mask>
    <filter id="glow" x="-20%" y="-40%" width="140%" height="180%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/>
    </filter>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0V24" fill="none" stroke="#ffffff" stroke-opacity="0.025"/>
    </pattern>
  </defs>
  <rect width="{W}" height="{H}" rx="28" fill="url(#bgGlow)"/>
  <rect width="{W}" height="{H}" rx="28" fill="url(#grid)"/>
  <g mask="url(#stripMask)"><g filter="url(#soft)">{"".join(cells)}</g></g>
  <path d="{frame}" fill="none" stroke="{CYAN}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <g filter="url(#glow)">{"".join(arcs)}</g>
  <path d="{trace}" fill="none" stroke="#a5f3fc" stroke-width="3.2" stroke-linejoin="round" filter="url(#glow)"/>
  <g filter="url(#shadow)">{text}</g>
</svg>
'''


# ---- square mark (favicon / app icon) ----------------------------------------------------

def mark() -> str:
    arcs = []
    for i, rad in enumerate([7, 12.5, 18]):
        a0, a1 = math.radians(200), math.radians(-20)
        cx, cy = 16, 19
        sx, sy = cx + rad * math.cos(a0), cy - rad * math.sin(a0)
        ex, ey = cx + rad * math.cos(a1), cy - rad * math.sin(a1)
        arcs.append(f'<path d="M{sx:.2f} {sy:.2f}A{rad} {rad} 0 1 1 {ex:.2f} {ey:.2f}" stroke="url(#a)" '
                    f'stroke-width="{2.6 - i * 0.35:.2f}" fill="none" stroke-linecap="round"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="a" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="{CYAN}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#7dd3fc"/>
    </linearGradient>
    <linearGradient id="w" x1="0" x2="1">
      <stop offset="0" stop-color="#1e40af"/><stop offset="0.35" stop-color="#22d3ee"/>
      <stop offset="0.5" stop-color="#facc15"/><stop offset="0.65" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#1e40af"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="{BG}"/>
  {"".join(arcs)}
  <rect x="3" y="25" width="26" height="3.5" rx="1" fill="url(#w)"/>
  <path d="M3 24.5H11L14 21 16 9 18 21 21 23.5H29" fill="none" stroke="#a5f3fc" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
</svg>
'''


def main():
    out = ROOT / "docs/images"
    out.mkdir(parents=True, exist_ok=True)
    (out / "logo.svg").write_text(banner())
    m = mark()
    (out / "mark.svg").write_text(m)
    pub = ROOT / "web/public"
    pub.mkdir(parents=True, exist_ok=True)
    (pub / "favicon.svg").write_text(m)
    print("wrote docs/images/logo.svg, docs/images/mark.svg, web/public/favicon.svg")


if __name__ == "__main__":
    main()
