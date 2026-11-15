// The spectrogram's view model: which part of the [0, 1]² texture is visible, the zoom
// history, every navigation rule (clamping, zoom about a point, drag-pan, box zoom, keys) and
// the view's URL encoding. No DOM and no WebGL, so it is unit-tested directly; the WebGL
// renderer (SpectrogramView) draws whatever view this holds and turns pointer input into calls
// here, and the Viewer page mirrors it into the URL and the detail plots.

/** Visible part of the data in [0, 1] texture space. x = frequency, y = time (0 = start). */
export interface View {
  x0: number
  x1: number
  y0: number
  y1: number
}

export const FULL_VIEW: View = { x0: 0, x1: 1, y0: 0, y1: 1 }

export type Mode = 'zoom' | 'pan'

/** Navigation the model carries out itself. */
export type ViewAction =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; fx: number; fy: number }
  | { kind: 'reset' }
  | { kind: 'back' }

/** Keys that mean something to the page around the plot rather than to the view. */
export type PageAction =
  | { kind: 'mode'; mode: Mode }
  | { kind: 'toggleAnnotations' }
  | { kind: 'togglePanel'; panel: 'spectrum' | 'time' }
  | { kind: 'cancelGesture' }

const PAN_STEP = 0.1
const ZOOM_IN = 0.8
/** A box narrower than this many pixels zooms along its other axis only. */
export const THIN_PX = 10
/** A drag shorter than this many pixels is a click. */
export const CLICK_PX = 4
const HISTORY_MAX = 100

/**
 * The whole key map of the spectrogram. Arrows pan, +/- zoom time, ]/[ zoom frequency, 0 or
 * Home resets, Backspace goes back; Z and H/P pick the mouse mode, A toggles annotations, S
 * and T toggle the Spectrum and Time panels, Escape cancels a drag. Null: not ours.
 */
export function keyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ViewAction | PageAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  switch (e.key) {
    case 'ArrowLeft': return { kind: 'pan', dx: -PAN_STEP, dy: 0 }
    case 'ArrowRight': return { kind: 'pan', dx: PAN_STEP, dy: 0 }
    case 'ArrowUp': return { kind: 'pan', dx: 0, dy: -PAN_STEP }
    case 'ArrowDown': return { kind: 'pan', dx: 0, dy: PAN_STEP }
    case '+': case '=': return { kind: 'zoom', fx: 1, fy: ZOOM_IN }
    case '-': case '_': return { kind: 'zoom', fx: 1, fy: 1 / ZOOM_IN }
    case ']': return { kind: 'zoom', fx: ZOOM_IN, fy: 1 }
    case '[': return { kind: 'zoom', fx: 1 / ZOOM_IN, fy: 1 }
    case '0': case 'Home': return { kind: 'reset' }
    case 'Backspace': return { kind: 'back' }
    case 'Escape': return { kind: 'cancelGesture' }
  }
  switch (e.key.toLowerCase()) {
    case 'z': return { kind: 'mode', mode: 'zoom' }
    case 'h': case 'p': return { kind: 'mode', mode: 'pan' }
    case 'a': return { kind: 'toggleAnnotations' }
    case 's': return { kind: 'togglePanel', panel: 'spectrum' }
    case 't': return { kind: 'togglePanel', panel: 'time' }
  }
  return null
}

export function isViewAction(a: ViewAction | PageAction): a is ViewAction {
  return a.kind === 'pan' || a.kind === 'zoom' || a.kind === 'reset' || a.kind === 'back'
}

/** URL form of a view: four numbers to 5 decimals; undefined for the full view. */
export function encodeView(v: View): string | undefined {
  if (sameView(v, FULL_VIEW)) return undefined
  return [v.x0, v.x1, v.y0, v.y1].map((n) => +n.toFixed(5)).join(',')
}

export function decodeView(s: string | undefined): View | null {
  const p = s?.split(',').map(Number)
  if (!p || p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null
  return { x0: p[0], x1: p[1], y0: p[2], y1: p[3] }
}

export function sameView(a: View, b: View) {
  return a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1
}

export interface ViewState {
  view: View
  canGoBack: boolean
}

export class ViewModel {
  private v: View = { ...FULL_VIEW }
  private history: View[] = []
  private listeners = new Set<(s: ViewState) => void>()
  /** Smallest visible span per axis: two texels of the data on screen. */
  private minW = 0
  private minH = 0
  private drag: { from: View; moved: boolean } | null = null

  constructor(initial: View = FULL_VIEW) {
    this.v = this.clamp(initial)
  }

  get view(): View {
    return { ...this.v }
  }

  get canGoBack() {
    return this.history.length > 0
  }

  /** Called on every change, with the new view. Returns an unsubscribe function. */
  subscribe(fn: (s: ViewState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Size of the data in texels, which limits how far in you can zoom (two texels). */
  setResolution(width: number, height: number) {
    this.minW = Math.min(1, 2 / Math.max(width, 1))
    this.minH = Math.min(1, 2 / Math.max(height, 1))
    this.set(this.v)
  }

  /** Show `v`, clamped to the data. `record` puts the current view on the history first. */
  set(v: View, record = false) {
    const next = this.clamp(v)
    if (sameView(next, this.v)) return
    if (record) this.push(this.v)
    this.v = next
    this.emit()
  }

  back() {
    const prev = this.history.pop()
    if (prev) this.v = this.clamp(prev)
    this.emit()
  }

  reset() {
    this.set(FULL_VIEW, true)
  }

  /** Zoom by `fx`/`fy` (< 1 zooms in) about a point given as a fraction of the visible area. */
  zoom(fx: number, fy: number, px = 0.5, py = 0.5, record = false) {
    const v = this.v
    const cx = v.x0 + (v.x1 - v.x0) * px
    const cy = v.y0 + (v.y1 - v.y0) * py
    this.set({ x0: cx - (cx - v.x0) * fx, x1: cx + (v.x1 - cx) * fx, y0: cy - (cy - v.y0) * fy, y1: cy + (v.y1 - cy) * fy }, record)
  }

  /** Pan by a fraction of the visible span. */
  pan(dx: number, dy: number) {
    const v = this.v
    const sx = (v.x1 - v.x0) * dx
    const sy = (v.y1 - v.y0) * dy
    this.set({ x0: v.x0 + sx, x1: v.x1 + sx, y0: v.y0 + sy, y1: v.y1 + sy })
  }

  /** Zoom so `r` (texture space) fills the view with some padding around it. */
  zoomTo(r: View, pad = 0.35) {
    const pw = Math.max((r.x1 - r.x0) * pad, 2 * this.minW)
    const ph = Math.max((r.y1 - r.y0) * pad, 2 * this.minH)
    this.set({ x0: r.x0 - pw, x1: r.x1 + pw, y0: r.y0 - ph, y1: r.y1 + ph }, true)
  }

  /**
   * Zoom to a box dragged on the plot, corners as fractions of the visible area. A box thinner
   * than THIN_PX in one direction keeps that axis as it is; one smaller than CLICK_PX in both
   * is not a zoom (returns false: treat it as a click).
   */
  zoomToBox(a: { x: number; y: number }, b: { x: number; y: number }, plotPx: { w: number; h: number }): boolean {
    const wpx = Math.abs(b.x - a.x) * plotPx.w
    const hpx = Math.abs(b.y - a.y) * plotPx.h
    if (wpx < CLICK_PX && hpx < CLICK_PX) return false
    const v = this.v
    const tx = (f: number) => v.x0 + (v.x1 - v.x0) * f
    const ty = (f: number) => v.y0 + (v.y1 - v.y0) * f
    this.set(
      {
        x0: wpx < THIN_PX ? v.x0 : tx(Math.min(a.x, b.x)),
        x1: wpx < THIN_PX ? v.x1 : tx(Math.max(a.x, b.x)),
        y0: hpx < THIN_PX ? v.y0 : ty(Math.min(a.y, b.y)),
        y1: hpx < THIN_PX ? v.y1 : ty(Math.max(a.y, b.y)),
      },
      true,
    )
    return true
  }

  /** Start a drag-pan from the current view. */
  beginDrag() {
    this.drag = { from: { ...this.v }, moved: false }
  }

  /**
   * Move a drag-pan: the pointer has moved by (dx, dy) fractions of the plot since the drag
   * began, `px` pixels in total. The first move past CLICK_PX records the starting view.
   */
  dragTo(dx: number, dy: number, px: number) {
    const d = this.drag
    if (!d) return
    if (!d.moved && px > CLICK_PX) {
      d.moved = true
      this.push(d.from)
    }
    const f = d.from
    const sx = dx * (f.x1 - f.x0)
    const sy = dy * (f.y1 - f.y0)
    this.set({ x0: f.x0 - sx, x1: f.x1 - sx, y0: f.y0 - sy, y1: f.y1 - sy })
  }

  /** End a drag-pan. Returns whether it moved (false: it was a click). */
  endDrag(): boolean {
    const moved = this.drag?.moved ?? false
    this.drag = null
    return moved
  }

  apply(a: ViewAction) {
    switch (a.kind) {
      case 'pan': return this.pan(a.dx, a.dy)
      case 'zoom': return this.zoom(a.fx, a.fy)
      case 'reset': return this.reset()
      case 'back': return this.back()
    }
  }

  private push(v: View) {
    this.history.push({ ...v })
    if (this.history.length > HISTORY_MAX) this.history.shift()
  }

  private clamp(v: View): View {
    const fit = (a: number, b: number, min: number): [number, number] => {
      let span = Math.min(1, Math.max(min, Math.abs(b - a)))
      let start = Math.min(1 - span, Math.max(0, Math.min(a, b)))
      if (!isFinite(start) || !isFinite(span)) [start, span] = [0, 1]
      return [start, start + span]
    }
    const [x0, x1] = fit(v.x0, v.x1, this.minW)
    const [y0, y1] = fit(v.y0, v.y1, this.minH)
    return { x0, x1, y0, y1 }
  }

  private emit() {
    const s = { view: this.view, canGoBack: this.canGoBack }
    for (const fn of this.listeners) fn(s)
  }
}
