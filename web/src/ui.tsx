// Small shared UI pieces: icons (inline SVG, no icon font or CDN), buttons, segmented control.

import { useState, type ReactNode } from 'react'

const ICONS = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  boxZoom: <><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3" /><circle cx="15" cy="15" r="3.5" /><path d="m21 21-3.5-3.5" /></>,
  pan: <><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></>,
  back: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  fit: <><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" /></>,
  tag: <><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  arrowLeft: <><path d="M19 12H5M12 19l-7-7 7-7" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M8 15l2-3 2 4 2-5 2 4" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  spectrum: <><path d="M3 20h18" /><path d="M3 17l3-1 2-8 2 8 2-3 2 2 2-11 2 12 2 1h2" /></>,
  wave: <><path d="M2 12c1.7-5 3.3-5 5 0s3.3 5 5 0 3.3-5 5 0 3.3 5 5 0" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

/** App mark: broadcast arcs over a spectrum peak and a waterfall strip (docs/images/mark.svg). */
export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="mk-a" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.35" />
          <stop offset="1" stopColor="#7dd3fc" />
        </linearGradient>
        <linearGradient id="mk-w" x1="0" x2="1">
          <stop offset="0" stopColor="#1e40af" />
          <stop offset="0.35" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#facc15" />
          <stop offset="0.65" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#1e40af" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="#050a17" stroke="rgba(34,211,238,0.35)" />
      <path d="M9.42 21.96A7 7 0 1 1 22.58 21.39" stroke="url(#mk-a)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M4.25 23.28A12.5 12.5 0 1 1 27.75 22.26" stroke="url(#mk-a)" strokeWidth="2.25" fill="none" strokeLinecap="round" opacity="0.8" />
      <rect x="3" y="25" width="26" height="3.5" rx="1" fill="url(#mk-w)" />
      <path d="M3 24.5H11L14 21 16 9 18 21 21 23.5H29" fill="none" stroke="#a5f3fc" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** "T-RF/IQ" wordmark in the brand style (bold italic, IQ in cyan). */
export function Wordmark() {
  return (
    <span className="wordmark" aria-label="T-RF/IQ">
      T-RF/<span className="wordmark-iq">IQ</span>
    </span>
  )
}

export function IconButton(props: {
  icon: IconName
  label: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  spin?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' active' : ''}${props.spin ? ' spin' : ''}${props.className ? ` ${props.className}` : ''}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <Icon name={props.icon} />
      {props.children}
    </button>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          title={o.title}
          className={o.value === props.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Divider() {
  return <span className="divider" aria-hidden="true" />
}

/** Copies `text` to the clipboard; the icon turns into a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const copy = () => {
    // navigator.clipboard is undefined outside secure contexts; the .then wrapper turns that into a rejection.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => setState('done'), () => setState('failed'))
      .finally(() => setTimeout(() => setState('idle'), 1200))
  }
  return (
    <IconButton
      icon={state === 'done' ? 'check' : 'copy'}
      label={state === 'failed' ? 'Copy failed (clipboard needs HTTPS or localhost)' : `Copy ${label}`}
      className="copy-btn"
      onClick={copy}
    />
  )
}
