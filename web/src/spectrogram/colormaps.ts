// 256-entry RGBA lookup tables, uploaded once as a texture. Polynomial fits keep this file
// small: turbo (Google, Apache-2.0) and viridis (Matt Zucker's fit of the matplotlib map).

export const COLORMAPS = ['turbo', 'viridis', 'gray'] as const
export type Colormap = (typeof COLORMAPS)[number]

type Rgb = [number, number, number]

const poly = (t: number, c: number[]) => c.reduceRight((acc, k) => acc * t + k, 0)

const turbo = (t: number): Rgb => [
  poly(t, [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943]),
  poly(t, [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604]),
  poly(t, [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973]),
]

const viridis = (t: number): Rgb => [
  poly(t, [0.2777273272234177, 0.1050930431085774, -0.3308618287255563, -4.634230498983486, 6.228269936347081, 4.776384997670288, -5.435455855934631]),
  poly(t, [0.005407344544966578, 1.404613529898575, 0.214847559468213, -5.799100973351585, 14.17993336680509, -13.74514537774601, 4.645852612178535]),
  poly(t, [0.3340998053353061, 1.384590162594685, 0.09509516302823659, -19.33244095627987, 56.69055260068105, -65.35303263337234, 26.3124352495832]),
]

const gray = (t: number): Rgb => [t, t, t]

const FNS: Record<Colormap, (t: number) => Rgb> = { turbo, viridis, gray }

export function colormapLut(name: Colormap): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  const f = FNS[name] ?? turbo
  for (let i = 0; i < 256; i++) {
    const rgb = f(i / 255)
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(Math.min(1, Math.max(0, rgb[c])) * 255)
    lut[i * 4 + 3] = 255
  }
  return lut
}

/** CSS colours sampled evenly along a colormap, for legends and swatches. */
export function colormapStops(name: Colormap, n = 12): string[] {
  const f = FNS[name] ?? turbo
  return Array.from({ length: n }, (_, i) => {
    const [r, g, b] = f(i / (n - 1)).map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255))
    return `rgb(${r} ${g} ${b})`
  })
}
