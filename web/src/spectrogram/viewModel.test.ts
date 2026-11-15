import { describe, expect, test } from 'bun:test'
import { FULL_VIEW, ViewModel, decodeView, encodeView, isViewAction, keyAction, type View } from './viewModel'

const v = (x0: number, x1: number, y0: number, y1: number): View => ({ x0, x1, y0, y1 })
const near = (a: View, b: View) => {
  for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(a[k]).toBeCloseTo(b[k], 9)
}

describe('ViewModel', () => {
  test('clamps views to the data and to a two-texel minimum span', () => {
    const m = new ViewModel(v(-0.5, 0.25, 0.9, 1.4))
    near(m.view, v(0, 0.75, 0.5, 1))
    m.setResolution(100, 10)
    m.set(v(0.5, 0.5001, 0.2, 0.2))
    near(m.view, v(0.5, 0.52, 0.2, 0.4))
    // Upside-down rectangles are normalised.
    m.set(v(0.6, 0.4, 0.9, 0.5))
    near(m.view, v(0.4, 0.6, 0.5, 0.9))
  })

  test('zooms about a point and pans by a fraction of the view', () => {
    const m = new ViewModel()
    m.zoom(0.5, 0.5, 0.25, 0.75)
    near(m.view, v(0.125, 0.625, 0.375, 0.875))
    m.pan(0.1, -0.2)
    near(m.view, v(0.175, 0.675, 0.275, 0.775))
    m.pan(5, 5) // stops at the edge
    near(m.view, v(0.5, 1, 0.5, 1))
  })

  test('records history for deliberate zooms and walks it back', () => {
    const m = new ViewModel()
    const seen: boolean[] = []
    m.subscribe((s) => seen.push(s.canGoBack))
    m.zoom(0.5, 0.5) // wheel-style: not recorded
    expect(m.canGoBack).toBe(false)
    m.zoomTo(v(0.4, 0.5, 0.4, 0.5))
    m.reset()
    expect(m.canGoBack).toBe(true)
    m.back()
    near(m.view, v(0.365, 0.535, 0.365, 0.535))
    m.back()
    near(m.view, v(0.25, 0.75, 0.25, 0.75))
    m.back() // nothing left: stays put
    near(m.view, v(0.25, 0.75, 0.25, 0.75))
    expect(seen.at(-1)).toBe(false)
  })

  test('box zoom: a box zooms, a thin box zooms one axis, a dot is a click', () => {
    const plot = { w: 1000, h: 500 }
    const m = new ViewModel()
    expect(m.zoomToBox({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.502 }, plot)).toBe(false)
    expect(m.canGoBack).toBe(false)
    // 5 px wide, 250 px tall: keeps the frequency span, zooms time.
    expect(m.zoomToBox({ x: 0.5, y: 0.25 }, { x: 0.505, y: 0.75 }, plot)).toBe(true)
    near(m.view, v(0, 1, 0.25, 0.75))
    m.zoomToBox({ x: 0.75, y: 0 }, { x: 0.25, y: 1 }, plot)
    near(m.view, v(0.25, 0.75, 0.25, 0.75))
    expect(m.canGoBack).toBe(true)
  })

  test('drag-pan records the starting view once it really moves', () => {
    const m = new ViewModel(v(0.25, 0.75, 0.25, 0.75))
    m.beginDrag()
    m.dragTo(0.001, 0, 1)
    expect(m.canGoBack).toBe(false)
    m.dragTo(0.2, -0.1, 150)
    near(m.view, v(0.15, 0.65, 0.3, 0.8))
    expect(m.endDrag()).toBe(true)
    m.back()
    near(m.view, v(0.25, 0.75, 0.25, 0.75))
    m.beginDrag()
    expect(m.endDrag()).toBe(false) // a click
  })

  test('notifies subscribers once per change', () => {
    const m = new ViewModel()
    let n = 0
    const off = m.subscribe(() => n++)
    m.set(FULL_VIEW) // no change
    m.pan(0, 0)
    m.zoom(0.5, 1)
    off()
    m.zoom(0.5, 1)
    expect(n).toBe(1)
  })
})

describe('keys', () => {
  test('navigation keys act on the view, page keys go to the page', () => {
    const m = new ViewModel()
    for (const key of ['+', '+', 'ArrowDown', ']']) {
      const a = keyAction({ key })!
      expect(isViewAction(a)).toBe(true)
      if (isViewAction(a)) m.apply(a)
    }
    expect(m.view.y1 - m.view.y0).toBeCloseTo(0.64, 9)
    expect(m.view.x1 - m.view.x0).toBeCloseTo(0.8, 9)
    expect(keyAction({ key: 'P' })).toEqual({ kind: 'mode', mode: 'pan' })
    expect(keyAction({ key: 't' })).toEqual({ kind: 'togglePanel', panel: 'time' })
    expect(keyAction({ key: 'a', ctrlKey: true })).toBeNull()
    expect(keyAction({ key: 'q' })).toBeNull()
  })
})

describe('URL form', () => {
  test('round-trips to 5 decimals and omits the full view', () => {
    expect(encodeView(FULL_VIEW)).toBeUndefined()
    expect(encodeView(v(0.1234567, 0.5, 0, 1))).toBe('0.12346,0.5,0,1')
    expect(decodeView('0.12346,0.5,0,1')).toEqual(v(0.12346, 0.5, 0, 1))
    expect(decodeView('1,2,3')).toBeNull()
    expect(decodeView('a,b,c,d')).toBeNull()
    expect(decodeView(undefined)).toBeNull()
  })
})
