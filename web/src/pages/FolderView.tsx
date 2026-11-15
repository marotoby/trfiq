// Folder view: a file-explorer over the (already filtered) recording list. The tree is derived
// client-side from recording paths: sources at the top, then the folders in each `stem`.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Recording, type SourceInfo } from '../api'
import { Icon } from '../ui'

interface FolderNode {
  /** `''` for the top, `source` for a source root, `source/a/b` for a folder. */
  key: string
  name: string
  depth: number
  kind: 'top' | 's3' | 'local' | 'folder'
  children: FolderNode[]
  /** Recordings directly in this folder. */
  files: Recording[]
  /** Recordings in this folder and below. */
  total: number
}

function buildTree(data: Recording[], sources: SourceInfo[] | undefined): Map<string, FolderNode> {
  const nodes = new Map<string, FolderNode>()
  const top: FolderNode = { key: '', name: 'All sources', depth: 0, kind: 'top', children: [], files: [], total: 0 }
  nodes.set('', top)
  const info = new Map((sources ?? []).map((s) => [s.id, s]))

  const get = (key: string): FolderNode => {
    const found = nodes.get(key)
    if (found) return found
    const cut = key.lastIndexOf('/')
    const parent = get(cut < 0 ? '' : key.slice(0, cut))
    const isSource = cut < 0
    const src = isSource ? info.get(key) : undefined
    const node: FolderNode = {
      key,
      name: isSource ? (src?.name ?? key) : key.slice(cut + 1),
      depth: parent.depth + 1,
      kind: isSource ? (src?.kind ?? 'folder') : 'folder',
      children: [],
      files: [],
      total: 0,
    }
    parent.children.push(node)
    nodes.set(key, node)
    return node
  }

  for (const r of data) {
    const cut = r.stem.lastIndexOf('/')
    const node = get(cut < 0 ? r.source : `${r.source}/${r.stem.slice(0, cut)}`)
    node.files.push(r)
    // Count it in every ancestor, up to the top.
    for (let k: string | null = node.key; k != null; k = k === '' ? null : parentKey(k)) nodes.get(k)!.total++
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return nodes
}

function parentKey(key: string): string {
  const cut = key.lastIndexOf('/')
  return cut < 0 ? '' : key.slice(0, cut)
}

/** `source/a/b` → ['', 'source', 'source/a', 'source/a/b']. */
function ancestry(key: string): string[] {
  if (!key) return ['']
  const parts = key.split('/')
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
}

const NODE_ICON = { top: 'database', s3: 'database', local: 'folder', folder: 'folder' } as const

export function FolderView(props: {
  data: Recording[]
  dir: string | undefined
  onDir: (dir: string | undefined) => void
  /** Renders the recordings directly in the selected folder. */
  renderFiles: (files: Recording[], emptyText: string) => ReactNode
}) {
  const sources = useQuery({ queryKey: ['sources'], queryFn: ({ signal }) => api.sources(signal) })
  const nodes = useMemo(() => buildTree(props.data, sources.data), [props.data, sources.data])

  // Default: the only source if there's one, else the top level.
  const top = nodes.get('')!
  const selectedKey = props.dir ?? (top.children.length === 1 ? top.children[0].key : '')
  const node = nodes.get(selectedKey)

  // Expanded folders: the top, every source, and the path to the selection.
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setOpen((o) => {
      const n = new Set(o)
      for (const k of ancestry(selectedKey)) n.add(k)
      for (const c of top.children) n.add(c.key)
      return n.size === o.size ? o : n
    })
  }, [selectedKey, top])

  const select = (key: string) => props.onDir(key || undefined)
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const crumbs = ancestry(selectedKey).map((k) => nodes.get(k) ?? { key: k, name: k.slice(k.lastIndexOf('/') + 1) })

  return (
    <div className="folders">
      <nav className="tree card" aria-label="Folders">
        <TreeRows node={top} selected={selectedKey} open={open} onSelect={select} onToggle={toggle} />
      </nav>
      <section className="folder-pane">
        <div className="crumbs-bar" aria-label="Folder path">
          {crumbs.map((c, i) => (
            <span key={c.key} className="crumb">
              {i > 0 && <Icon name="chevron" size={12} />}
              <button type="button" onClick={() => select(c.key)} aria-current={c.key === selectedKey ? 'page' : undefined}>
                {c.name}
              </button>
            </span>
          ))}
          {node && <span className="muted small crumb-count">{node.total.toLocaleString()} recordings</span>}
        </div>
        {node && node.children.length > 0 && (
          <div className="subfolders">
            {node.children.map((c) => (
              <button key={c.key} type="button" className="subfolder" onClick={() => select(c.key)} title={c.key}>
                <Icon name={NODE_ICON[c.kind]} size={18} />
                <span className="subfolder-name">{c.name}</span>
                <span className="muted small">{c.total.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
        {node
          ? (node.files.length > 0 || node.children.length === 0) &&
            props.renderFiles(node.files, 'No recordings in this folder.')
          : props.renderFiles([], 'No recordings here match the current search or filter.')}
      </section>
    </div>
  )
}

function TreeRows(p: {
  node: FolderNode
  selected: string
  open: Set<string>
  onSelect: (key: string) => void
  onToggle: (key: string) => void
}) {
  const { node } = p
  const isOpen = p.open.has(node.key)
  const hasKids = node.children.length > 0
  return (
    <>
      <div
        role="treeitem"
        aria-selected={node.key === p.selected}
        aria-expanded={hasKids ? isOpen : undefined}
        className={`tree-row${node.key === p.selected ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + node.depth * 14 }}
      >
        <button
          type="button"
          className={`tree-chevron${isOpen ? ' open' : ''}`}
          onClick={() => p.onToggle(node.key)}
          aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
          disabled={!hasKids}
        >
          {hasKids && <Icon name="chevron" size={12} />}
        </button>
        <button type="button" className="tree-label" onClick={() => p.onSelect(node.key)} title={node.key || node.name}>
          <Icon name={NODE_ICON[node.kind]} size={14} />
          <span className="tree-name">{node.name}</span>
          <span className="tree-count">{node.total.toLocaleString()}</span>
        </button>
      </div>
      {isOpen && node.children.map((c) => <TreeRows key={c.key} {...p} node={c} />)}
    </>
  )
}
