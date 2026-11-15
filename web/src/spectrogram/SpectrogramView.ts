// WebGL2 spectrogram renderer, deliberately outside React's render cycle: React hands it data
// and settings, it draws the view its ViewModel holds on requestAnimationFrame, and it turns
// pointer input into ViewModel calls. Navigation rules live in viewModel.ts, not here.
//
// Data is uploaded once as an R16UI texture of quantised dB (ADR 0002). The fragment shader
// maps dB → colour through a LUT, so colormap and dB-range changes never touch the data.
// When zoomed out, each screen pixel covers several texels; the shader takes their max
// (max-hold) so short bursts never disappear between pixels.

import { colormapLut, type Colormap } from './colormaps'
import { ticks } from '../format'
import type { Geometry } from '../geometry'
import { dbOf, dbPercentiles, type Overview, type Quant } from '../wire'
import { FULL_VIEW, ViewModel, type Mode, type View } from './viewModel'

export { FULL_VIEW, type Mode, type View }

export interface CursorInfo {
  freq: number
  time: number
  db: number | null
  annotation: string | null
}

/** An annotation in [0, 1] texture space (same space as View). */
export interface PlotAnnotation extends View {
  id: number
  label: string
  color: string
}

const MARGIN = { left: 76, bottom: 28, top: 8, right: 10 }
/** Max texels sampled per axis per pixel; beyond this the max-hold strides. */
const MAX_TAPS = 12

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_data;
uniform sampler2D u_lut;
uniform vec4 u_view;     // x0, x1, y0, y1
uniform vec2 u_size;     // canvas size in device px
uniform vec2 u_db;       // lo, hi
uniform vec2 u_quant;    // dbMin, dbStep
out vec4 o;

void main() {
  ivec2 tex = textureSize(u_data, 0);
  vec2 frag = floor(gl_FragCoord.xy);
  // Pixel bounds in [0,1] screen space; y flipped so time runs downwards.
  vec2 s0 = vec2(frag.x, u_size.y - frag.y - 1.0) / u_size;
  vec2 s1 = s0 + 1.0 / u_size;
  vec2 t0 = vec2(mix(u_view.x, u_view.y, s0.x), mix(u_view.z, u_view.w, s0.y));
  vec2 t1 = vec2(mix(u_view.x, u_view.y, s1.x), mix(u_view.z, u_view.w, s1.y));
  ivec2 i0 = clamp(ivec2(floor(t0 * vec2(tex))), ivec2(0), tex - 1);
  ivec2 i1 = clamp(ivec2(ceil(t1 * vec2(tex))) - 1, i0, tex - 1);
  ivec2 n = i1 - i0 + 1;
  ivec2 step = max(ivec2(1), (n + ${MAX_TAPS - 1}) / ${MAX_TAPS});
  uint q = 0u;
  for (int y = i0.y; y <= i1.y; y += step.y) {
    for (int x = i0.x; x <= i1.x; x += step.x) {
      q = max(q, texelFetch(u_data, ivec2(x, y), 0).r);
    }
  }
  float db = u_quant.x + float(q) * u_quant.y;
  float c = clamp((db - u_db.x) / max(u_db.y - u_db.x, 1e-3), 0.0, 1.0);
  o = texture(u_lut, vec2(c, 0.5));
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
  return s
}

type Gesture =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }

export class SpectrogramView {
  onCursor?: (c: CursorInfo | null) => void
  onAnnotationClick?: (id: number | null) => void

  private glCanvas: HTMLCanvasElement
  private overlayCanvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private ctx: CanvasRenderingContext2D
  private prog: WebGLProgram
  private dataTex: WebGLTexture
  private lutTex: WebGLTexture
  private u: Record<string, WebGLUniformLocation | null> = {}
  private data: Uint16Array | null = null
  private w = 0
  private h = 0
  private quant: Quant = { dbMin: -200, dbStep: 0.005 }
  private db = { lo: -120, hi: 0 }
  private geo: Geometry | null = null
  private mode: Mode = 'zoom'
  private annotations: PlotAnnotation[] = []
  private showAnnotations = true
  private selected: number | null = null
  private hovered: number | null = null
  private cursor: { x: number; y: number } | null = null
  private gesture: Gesture | null = null
  private raf = 0
  private ro: ResizeObserver
  private abort = new AbortController()

  private unsubscribe: () => void

  constructor(
    private root: HTMLElement,
    private model: ViewModel,
  ) {
    root.style.position = 'relative'
    this.glCanvas = document.createElement('canvas')
    this.overlayCanvas = document.createElement('canvas')
    Object.assign(this.glCanvas.style, {
      position: 'absolute',
      left: `${MARGIN.left}px`,
      top: `${MARGIN.top}px`,
      touchAction: 'none',
      borderRadius: '4px',
    })
    Object.assign(this.overlayCanvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    root.append(this.glCanvas, this.overlayCanvas)

    const gl = this.glCanvas.getContext('webgl2', { antialias: false, alpha: false })
    if (!gl) throw new Error('WebGL2 is not available in this browser')
    this.gl = gl
    this.ctx = this.overlayCanvas.getContext('2d')!

    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
    this.prog = prog
    for (const k of ['u_data', 'u_lut', 'u_view', 'u_size', 'u_db', 'u_quant'])
      this.u[k] = gl.getUniformLocation(prog, k)

    this.dataTex = gl.createTexture()!
    this.lutTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.setColormap('turbo')

    this.unsubscribe = model.subscribe(() => {
      this.emitCursor()
      this.invalidate()
    })
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(root)
    this.bindEvents()
    this.updateCursorStyle()
    this.resize()
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.unsubscribe()
    this.ro.disconnect()
    this.abort.abort()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.glCanvas.remove()
    this.overlayCanvas.remove()
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)
  }

  // ---- inputs from the owner --------------------------------------------------------------

  setData(o: Pick<Overview, 'data' | 'fft' | 'rows' | 'quant'>) {
    const { data, fft: width, rows: height, quant } = o
    if (width > this.maxTextureSize || height > this.maxTextureSize)
      throw new Error(`${width}×${height} exceeds this GPU's texture limit (${this.maxTextureSize})`)
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.data = data
    this.w = width
    this.h = height
    this.quant = quant
    this.model.setResolution(width, height)
    this.invalidate()
  }

  setColormap(name: Colormap) {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapLut(name))
    this.invalidate()
  }

  setDbRange(lo: number, hi: number) {
    this.db = { lo, hi }
    this.invalidate()
  }

  /** Units for the axes, cursor readout and box-zoom pill. */
  setGeometry(g: Geometry) {
    this.geo = g
    this.invalidate()
  }

  setMode(m: Mode) {
    this.mode = m
    this.updateCursorStyle()
  }

  setAnnotations(list: PlotAnnotation[]) {
    this.annotations = list
    this.invalidate()
  }

  setShowAnnotations(show: boolean) {
    this.showAnnotations = show
    this.invalidate()
  }

  setSelected(id: number | null) {
    this.selected = id
    this.invalidate()
  }

  /** Drop a box or pan drag in progress (Escape). */
  cancelGesture() {
    if (this.gesture?.kind === 'pan') this.model.endDrag()
    this.gesture = null
    this.updateCursorStyle()
    this.invalidate()
  }

  // ---- interaction ------------------------------------------------------------------------

  private plotSize() {
    return { w: this.glCanvas.clientWidth, h: this.glCanvas.clientHeight }
  }

  private toTex(p: { x: number; y: number }) {
    const v = this.model.view
    return { x: v.x0 + (v.x1 - v.x0) * p.x, y: v.y0 + (v.y1 - v.y0) * p.y }
  }

  private annotationAt(p: { x: number; y: number }): PlotAnnotation | null {
    if (!this.showAnnotations) return null
    const t = this.toTex(p)
    let best: PlotAnnotation | null = null
    for (const a of this.annotations) {
      if (t.x >= a.x0 && t.x <= a.x1 && t.y >= a.y0 && t.y <= a.y1) {
        // Prefer the smallest box under the cursor.
        if (!best || (a.x1 - a.x0) * (a.y1 - a.y0) < (best.x1 - best.x0) * (best.y1 - best.y0)) best = a
      }
    }
    return best
  }

  private updateCursorStyle() {
    const g = this.gesture
    this.glCanvas.style.cursor =
      g?.kind === 'pan' ? 'grabbing' : this.hovered != null ? 'pointer' : this.mode === 'pan' ? 'grab' : 'crosshair'
  }

  private bindEvents() {
    const c = this.glCanvas
    const opts = { signal: this.abort.signal }
    const rel = (e: MouseEvent) => {
      const r = c.getBoundingClientRect()
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    }

    c.addEventListener('contextmenu', (e) => e.preventDefault(), opts)
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const f = Math.exp(e.deltaY * 0.0015)
        const p = rel(e)
        // wheel: time; shift+wheel: frequency; ctrl/meta+wheel: both.
        const both = e.ctrlKey || e.metaKey
        this.model.zoom(e.shiftKey || both ? f : 1, e.shiftKey && !both ? 1 : f, p.x, p.y)
      },
      { ...opts, passive: false },
    )
    c.addEventListener(
      'pointerdown',
      (e) => {
        c.setPointerCapture(e.pointerId)
        const p = rel(e)
        // Left button follows the mode; middle/right always pan.
        if (e.button === 0 && this.mode === 'zoom') {
          this.gesture = { kind: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y }
        } else {
          this.gesture = { kind: 'pan', x: e.clientX, y: e.clientY }
          this.model.beginDrag()
        }
        this.updateCursorStyle()
      },
      opts,
    )
    c.addEventListener(
      'pointermove',
      (e) => {
        const p = rel(e)
        this.cursor = p
        const g = this.gesture
        if (g?.kind === 'pan') {
          const { w, h } = this.plotSize()
          const px = Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y)
          this.model.dragTo((e.clientX - g.x) / w, (e.clientY - g.y) / h, px)
        } else if (g?.kind === 'box') {
          g.x1 = Math.min(1, Math.max(0, p.x))
          g.y1 = Math.min(1, Math.max(0, p.y))
        } else {
          const hit = this.annotationAt(p)?.id ?? null
          if (hit !== this.hovered) {
            this.hovered = hit
            this.updateCursorStyle()
          }
        }
        this.emitCursor()
        this.invalidate()
      },
      opts,
    )
    const end = (e: PointerEvent) => {
      const g = this.gesture
      this.gesture = null
      if (!g) return
      const handled =
        g.kind === 'pan'
          ? this.model.endDrag()
          : this.model.zoomToBox({ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }, this.plotSize())
      if (!handled) this.click(rel(e))
      this.updateCursorStyle()
      this.invalidate()
    }
    c.addEventListener('pointerup', end, opts)
    c.addEventListener(
      'pointercancel',
      () => this.cancelGesture(),
      opts,
    )
    c.addEventListener(
      'pointerleave',
      () => {
        if (this.gesture) return
        this.cursor = null
        this.hovered = null
        this.onCursor?.(null)
        this.invalidate()
      },
      opts,
    )
    c.addEventListener('dblclick', () => this.model.reset(), opts)
  }

  private click(p: { x: number; y: number }) {
    const a = this.annotationAt(p)
    this.onAnnotationClick?.(a?.id ?? null)
  }

  private emitCursor() {
    if (!this.onCursor || !this.cursor || !this.geo) return
    const t = this.toTex(this.cursor)
    let db: number | null = null
    if (this.data && this.w) {
      const ix = Math.min(this.w - 1, Math.max(0, Math.floor(t.x * this.w)))
      const iy = Math.min(this.h - 1, Math.max(0, Math.floor(t.y * this.h)))
      db = dbOf(this.quant, this.data[iy * this.w + ix])
    }
    this.onCursor({
      freq: this.geo.freqAt(t.x),
      time: this.geo.timeAt(t.y),
      db,
      annotation: this.annotationAt(this.cursor)?.label ?? null,
    })
  }

  // ---- rendering --------------------------------------------------------------------------

  private resize() {
    const dpr = window.devicePixelRatio || 1
    const W = this.root.clientWidth
    const H = this.root.clientHeight
    const pw = Math.max(1, W - MARGIN.left - MARGIN.right)
    const ph = Math.max(1, H - MARGIN.top - MARGIN.bottom)
    this.glCanvas.style.width = `${pw}px`
    this.glCanvas.style.height = `${ph}px`
    this.glCanvas.width = Math.round(pw * dpr)
    this.glCanvas.height = Math.round(ph * dpr)
    this.overlayCanvas.width = Math.round(W * dpr)
    this.overlayCanvas.height = Math.round(H * dpr)
    this.overlayCanvas.style.width = `${W}px`
    this.overlayCanvas.style.height = `${H}px`
    this.invalidate()
  }

  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw())
  }

  private draw() {
    this.raf = 0
    const gl = this.gl
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height)
    gl.clearColor(0.04, 0.05, 0.07, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.data) {
      gl.useProgram(this.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex)
      gl.uniform1i(this.u.u_data, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
      gl.uniform1i(this.u.u_lut, 1)
      const v = this.model.view
      gl.uniform4f(this.u.u_view, v.x0, v.x1, v.y0, v.y1)
      gl.uniform2f(this.u.u_size, this.glCanvas.width, this.glCanvas.height)
      gl.uniform2f(this.u.u_db, this.db.lo, this.db.hi)
      gl.uniform2f(this.u.u_quant, this.quant.dbMin, this.quant.dbStep)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    this.drawOverlay()
  }

  private drawOverlay() {
    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height)
    const { w, h } = this.plotSize()
    const L = MARGIN.left
    const T = MARGIN.top
    const style = getComputedStyle(this.root)
    const muted = style.getPropertyValue('--fg-muted').trim() || '#8a93a6'
    const grid = style.getPropertyValue('--grid').trim() || 'rgba(255,255,255,0.06)'
    const mono = style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace'
    const v = this.model.view
    // Texture space → overlay pixels.
    const sx = (x: number) => L + ((x - v.x0) / (v.x1 - v.x0)) * w
    const sy = (y: number) => T + ((y - v.y0) / (v.y1 - v.y0)) * h

    ctx.font = `11px ${mono}`
    ctx.lineWidth = 1

    const geo = this.geo
    if (geo) {
      // Frequency axis (bottom).
      const f0 = geo.freqAt(v.x0)
      const f1 = geo.freqAt(v.x1)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const f of ticks(f0, f1, Math.max(2, Math.floor(w / 120)))) {
        const x = Math.round(L + ((f - f0) / (f1 - f0)) * w) + 0.5
        ctx.strokeStyle = grid
        ctx.beginPath()
        ctx.moveTo(x, T)
        ctx.lineTo(x, T + h)
        ctx.stroke()
        ctx.fillStyle = muted
        ctx.fillText(geo.formatFreq(f, 7), x, T + h + 8)
      }
      // Time axis (left).
      const t0 = geo.timeAt(v.y0)
      const t1 = geo.timeAt(v.y1)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const t of ticks(t0, t1, Math.max(2, Math.floor(h / 64)))) {
        const y = Math.round(T + ((t - t0) / (t1 - t0)) * h) + 0.5
        ctx.strokeStyle = grid
        ctx.beginPath()
        ctx.moveTo(L, y)
        ctx.lineTo(L + w, y)
        ctx.stroke()
        ctx.fillStyle = muted
        ctx.fillText(geo.formatTime(t), L - 8, y)
      }
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(L, T, w, h)
    ctx.clip()

    if (this.showAnnotations) this.drawAnnotations(sx, sy)

    const g = this.gesture
    if (g?.kind === 'box') {
      const x0 = L + Math.min(g.x0, g.x1) * w
      const y0 = T + Math.min(g.y0, g.y1) * h
      const bw = Math.abs(g.x1 - g.x0) * w
      const bh = Math.abs(g.y1 - g.y0) * h
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(x0, y0, bw, bh)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.setLineDash([5, 4])
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(bw), Math.round(bh))
      ctx.setLineDash([])
      if (geo && (bw > 30 || bh > 30)) {
        // Box corners in texture space.
        const tx = (s: number) => v.x0 + s * (v.x1 - v.x0)
        const ty = (s: number) => v.y0 + s * (v.y1 - v.y0)
        const df = Math.abs(geo.freqAt(tx(g.x1)) - geo.freqAt(tx(g.x0)))
        const dt = Math.abs(geo.timeAt(ty(g.y1)) - geo.timeAt(ty(g.y0)))
        this.pill(`Δf ${geo.formatFreq(df, 4)}   Δt ${geo.formatTime(dt)}`, x0 + 6, y0 + 6, 'rgba(15,17,23,0.85)', '#fff')
      }
    } else if (this.cursor && !g) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.setLineDash([3, 4])
      const x = Math.round(L + this.cursor.x * w) + 0.5
      const y = Math.round(T + this.cursor.y * h) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, T)
      ctx.lineTo(x, T + h)
      ctx.moveTo(L, y)
      ctx.lineTo(L + w, y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }

  private drawAnnotations(sx: (x: number) => number, sy: (y: number) => number) {
    const ctx = this.ctx
    const v = this.model.view
    for (const a of this.annotations) {
      if (a.x1 < v.x0 || a.x0 > v.x1 || a.y1 < v.y0 || a.y0 > v.y1) continue
      const active = a.id === this.selected || a.id === this.hovered
      // Keep tiny annotations visible: at least 3 px in each direction.
      let x0 = sx(a.x0)
      let x1 = sx(a.x1)
      let y0 = sy(a.y0)
      let y1 = sy(a.y1)
      if (x1 - x0 < 3) [x0, x1] = [(x0 + x1) / 2 - 1.5, (x0 + x1) / 2 + 1.5]
      if (y1 - y0 < 3) [y0, y1] = [(y0 + y1) / 2 - 1.5, (y0 + y1) / 2 + 1.5]
      ctx.globalAlpha = active ? 0.22 : 0.08
      ctx.fillStyle = a.color
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
      ctx.globalAlpha = active ? 1 : 0.85
      ctx.strokeStyle = a.color
      ctx.lineWidth = active ? 2 : 1.25
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0))
      ctx.globalAlpha = 1
      ctx.lineWidth = 1
      // Label above the box (or inside if at the top edge) when there's room or it's active.
      if (active || x1 - x0 > 40 || y1 - y0 > 40) {
        const ly = y0 - 18 < MARGIN.top ? y0 + 2 : y0 - 18
        this.pill(a.label, Math.max(MARGIN.left + 2, x0), ly, a.color, '#0b0d12')
      }
    }
  }

  private pill(text: string, x: number, y: number, bg: string, fg: string) {
    const ctx = this.ctx
    const style = getComputedStyle(this.root)
    ctx.font = `600 11px ${style.getPropertyValue('--font-sans').trim() || 'system-ui'}`
    const tw = ctx.measureText(text).width
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect(x, y, tw + 12, 16, 4)
    ctx.fill()
    ctx.fillStyle = fg
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + 6, y + 8.5)
  }
}

/** Pick a dB window from the data: a low percentile as floor, near-max as ceiling. */
export function autoDbRange(o: Pick<Overview, 'data' | 'quant'>) {
  const p = dbPercentiles(o, [0.05, 0.9995])
  if (!p) return { lo: -120, hi: 0 }
  const lo = Math.floor(p[0])
  return { lo, hi: Math.max(Math.ceil(p[1]), lo + 10) }
}
