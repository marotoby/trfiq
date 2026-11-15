import { Link, Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { WINDOWS, type Status, type WindowFn } from './api'
import { COLORMAPS, type Colormap } from './spectrogram/colormaps'
import { RecordingList } from './pages/RecordingList'
import { Viewer } from './pages/Viewer'
import { Logo } from './ui'

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const oneOf = <T extends string>(v: unknown, opts: readonly T[]) =>
  opts.includes(v as T) ? (v as T) : undefined

const rootRoute = createRootRoute({
  component: () => (
    <div className="app">
      <header className="topbar">
        <Link to="/" search={{}} className="brand">
          <Logo />
          <span>trfiq</span>
        </Link>
        <span className="tagline">IQ recording explorer</span>
      </header>
      <Outlet />
    </div>
  ),
})

export interface ListSearch {
  q?: string
  source?: string
  status?: Status
}

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>): ListSearch => ({
    q: str(s.q),
    source: str(s.source),
    status: oneOf(s.status, ['ok', 'needs_meta', 'broken'] as const),
  }),
  component: RecordingList,
})

/** Everything needed to reproduce a view is in the URL, so every view is a deep link. */
export interface ViewerSearch {
  fft?: number
  window?: WindowFn
  cmap?: Colormap
  lo?: number
  hi?: number
  /** Visible region "x0,x1,y0,y1". */
  v?: string
}

const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/r/$id',
  validateSearch: (s: Record<string, unknown>): ViewerSearch => ({
    fft: num(s.fft),
    window: oneOf(s.window, WINDOWS),
    cmap: oneOf(s.cmap, COLORMAPS),
    lo: num(s.lo),
    hi: num(s.hi),
    v: str(s.v),
  }),
  component: Viewer,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([listRoute, viewerRoute]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
