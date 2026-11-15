// Small waterfall image of a whole recording, for hover previews and the gallery.
// Uses a small strided overview (the same endpoint the viewer opens with), coloured on a 2D
// canvas, so no new server work is needed. Fetches only once the canvas is on screen.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Recording } from '../api'
import { colormapLut } from './colormaps'

/** FFT size of every thumbnail (its width in pixels). */
export const THUMB_FFT = 256
const ROWS = 128
const LUT = colormapLut('turbo')

/**
 * Display range for a thumbnail. Darker than the viewer's: black at the median (≈ the noise
 * floor) so signals stand out at a glance.
 */
function thumbLevels(data: Uint16Array, q: { dbMin: number; dbStep: number }) {
  const stride = Math.max(1, Math.floor(data.length / 20_000))
  const sample: number[] = []
  for (let i = 0; i < data.length; i += stride) if (data[i] > 0) sample.push(data[i])
  if (!sample.length) return { lo: -120, hi: 0 }
  sample.sort((a, b) => a - b)
  const at = (p: number) => q.dbMin + sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] * q.dbStep
  const lo = at(0.5)
  return { lo, hi: Math.max(at(0.9995), lo + 20) }
}

/** True once the element has been near the viewport (stays true). */
function useSeen(ref: RefObject<Element | null>) {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

export function Thumbnail({ r, className }: { r: Recording; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const seen = useSeen(canvas)
  const q = useQuery({
    queryKey: ['thumb', r.id, r.last_modified, r.size],
    queryFn: ({ signal }) => api.overview(r.id, { fft: THUMB_FFT, rows: ROWS, window: 'hann' }, signal),
    enabled: seen && r.viewable,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  })

  useEffect(() => {
    const c = canvas.current
    const d = q.data
    if (!c || !d) return
    c.width = d.fft
    c.height = d.rows
    const { lo, hi } = thumbLevels(d.data, d)
    // dB → LUT index, done once per quantised value range instead of per pixel maths.
    const scale = (255 * d.dbStep) / (hi - lo)
    const offset = (255 * (d.dbMin - lo)) / (hi - lo)
    const img = new ImageData(d.fft, d.rows)
    const px = img.data
    for (let i = 0; i < d.data.length; i++) {
      const k = Math.max(0, Math.min(255, Math.round(d.data[i] * scale + offset))) * 4
      px[4 * i] = LUT[k]
      px[4 * i + 1] = LUT[k + 1]
      px[4 * i + 2] = LUT[k + 2]
      px[4 * i + 3] = 255
    }
    c.getContext('2d')!.putImageData(img, 0, 0)
  }, [q.data])

  const state = q.data ? 'ready' : q.error ? 'error' : 'loading'
  return (
    <div className={`thumb thumb-${state}${className ? ` ${className}` : ''}`}>
      <canvas ref={canvas} width={THUMB_FFT} height={ROWS} aria-label={`Waterfall preview of ${r.name}`} />
      {q.error && <span className="thumb-msg">{q.error.message}</span>}
    </div>
  )
}
