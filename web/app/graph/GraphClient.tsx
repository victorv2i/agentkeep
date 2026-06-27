'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'

/**
 * The vault graph is still a canvas for cheap drawing, but the nodes also exist
 * as ordinary DOM controls in the side panel. Keyboard users can search, focus a
 * node, inspect neighbors, and open notes without touching the canvas.
 */

interface GraphNodeData {
  id: string
  title: string
  group: 'memory' | 'note' | 'placeholder'
  degree: number
}

interface SimNode extends SimulationNodeDatum, GraphNodeData {
  r: number
}

type SimLink = SimulationLinkDatum<SimNode>

interface GraphPayload {
  nodes: GraphNodeData[]
  links: { source: string; target: string }[]
}

interface GraphController {
  focusNode(id: string, opts?: { fit?: boolean }): void
  fitAll(): void
  reset(): void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 4
const LABEL_ZOOM = 1.2
const TOP_LABELS = 25

function nodeRadius(degree: number): number {
  return Math.min(14, Math.max(3, 3 + Math.sqrt(degree) * 2))
}

function groupLabel(group: GraphNodeData['group']): string {
  if (group === 'placeholder') return 'uncreated'
  return group
}

function compareNodes(a: GraphNodeData, b: GraphNodeData): number {
  return b.degree - a.degree || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
}

function buildNeighborMap(links: GraphPayload['links']): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const l of links) {
    if (!map.has(l.source)) map.set(l.source, new Set())
    if (!map.has(l.target)) map.set(l.target, new Set())
    map.get(l.source)!.add(l.target)
    map.get(l.target)!.add(l.source)
  }
  return map
}

export function GraphClient() {
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<GraphController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const [state, setState] = useState<'loading' | 'empty' | 'error' | 'ready'>('loading')
  const [graph, setGraph] = useState<GraphPayload | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNodeData>()
    for (const n of graph?.nodes ?? []) map.set(n.id, n)
    return map
  }, [graph])

  const neighborMap = useMemo(() => buildNeighborMap(graph?.links ?? []), [graph])

  const sortedNodes = useMemo(
    () => [...(graph?.nodes ?? [])].sort(compareNodes),
    [graph],
  )

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return sortedNodes
    return sortedNodes.filter((n) => {
      const haystack = `${n.title} ${n.id} ${n.group}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [query, sortedNodes])

  const activeNode = activeId ? nodeById.get(activeId) ?? null : null
  const activeNeighbors = activeNode
    ? [...(neighborMap.get(activeNode.id) ?? [])]
        .map((id) => nodeById.get(id))
        .filter((n): n is GraphNodeData => Boolean(n))
        .sort(compareNodes)
    : []

  function focusNode(id: string, fit = true): void {
    activeIdRef.current = id
    setActiveId(id)
    controllerRef.current?.focusNode(id, { fit })
  }

  function openNode(id: string): void {
    const node = nodeById.get(id)
    if (!node || node.group === 'placeholder') return
    router.push('/?path=' + encodeURIComponent(node.id))
  }

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let disposed = false
    let sim: Simulation<SimNode, SimLink> | null = null
    let raf = 0
    const cleanups: (() => void)[] = []

    let monoFamily = 'monospace'
    let edge = '#2A2B30'
    let memoryFill = '#A6C0FF'
    let noteFill = '#C9CAD1'
    let hollowStroke = '#8A8B92'
    let label = '#8A8B92'

    function refreshTheme(): void {
      const cs = getComputedStyle(document.body)
      const cssVar = (name: string, fallback: string) =>
        cs.getPropertyValue(name).trim() || fallback
      monoFamily = cssVar('--font-mono', 'monospace')
      edge = cssVar('--line-2', '#2A2B30')
      memoryFill = cssVar('--acc', '#A6C0FF')
      noteFill = cssVar('--mut', '#C9CAD1')
      hollowStroke = cssVar('--faint', '#8A8B92')
      label = cssVar('--mut', '#8A8B92')
    }
    refreshTheme()

    let width = 0
    let height = 0
    function resize(): void {
      const rect = container!.getBoundingClientRect()
      width = container!.clientWidth
      height = Math.max(320, window.innerHeight - rect.top)
      const dpr = window.devicePixelRatio || 1
      canvas!.width = Math.round(width * dpr)
      canvas!.height = Math.round(height * dpr)
      canvas!.style.width = `${width}px`
      canvas!.style.height = `${height}px`
    }

    let tx = 0
    let ty = 0
    let k = 1
    let hovered: SimNode | null = null
    let nodes: SimNode[] = []
    let links: SimLink[] = []
    const neighbors = new Map<string, Set<string>>()
    let topByDegree = new Set<string>()

    function toWorld(px: number, py: number): { x: number; y: number } {
      return { x: (px - tx) / k, y: (py - ty) / k }
    }

    function hitTest(px: number, py: number): SimNode | null {
      const { x, y } = toWorld(px, py)
      const slack = 4 / k
      let best: SimNode | null = null
      let bestD = Infinity
      for (const n of nodes) {
        const dx = (n.x ?? 0) - x
        const dy = (n.y ?? 0) - y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d <= n.r + slack && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    }

    function highlightedId(): string | null {
      return hovered?.id ?? activeIdRef.current
    }

    function isNeighbor(n: SimNode): boolean {
      const id = highlightedId()
      if (!id) return true
      if (n.id === id) return true
      return neighbors.get(id)?.has(n.id) ?? false
    }

    function draw(): void {
      const dpr = window.devicePixelRatio || 1
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, width, height)
      ctx!.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty)

      const id = highlightedId()
      ctx!.lineWidth = 1 / k
      ctx!.strokeStyle = edge
      for (const l of links) {
        const s = l.source as SimNode
        const t = l.target as SimNode
        const lit = !id || s.id === id || t.id === id
        ctx!.globalAlpha = lit ? 1 : 0.22
        ctx!.beginPath()
        ctx!.moveTo(s.x ?? 0, s.y ?? 0)
        ctx!.lineTo(t.x ?? 0, t.y ?? 0)
        ctx!.stroke()
      }

      for (const n of nodes) {
        ctx!.globalAlpha = isNeighbor(n) ? 1 : 0.22
        ctx!.beginPath()
        ctx!.arc(n.x ?? 0, n.y ?? 0, n.r, 0, Math.PI * 2)
        if (n.group === 'placeholder') {
          ctx!.lineWidth = 1 / k
          ctx!.strokeStyle = hollowStroke
          ctx!.stroke()
        } else {
          ctx!.fillStyle = n.group === 'memory' ? memoryFill : noteFill
          ctx!.fill()
        }
      }

      ctx!.font = `${10 / k}px ${monoFamily}`
      ctx!.fillStyle = label
      ctx!.textBaseline = 'middle'
      for (const n of nodes) {
        const highlightLabel = Boolean(id && (n.id === id || isNeighbor(n)))
        const zoomLabel = k > LABEL_ZOOM && topByDegree.has(n.id)
        if (!highlightLabel && !zoomLabel) continue
        ctx!.globalAlpha = isNeighbor(n) ? 1 : 0.25
        ctx!.fillText(n.title, (n.x ?? 0) + n.r + 5 / k, n.y ?? 0)
      }
      ctx!.globalAlpha = 1
    }

    function scheduleDraw(): void {
      if (raf || disposed) return
      raf = requestAnimationFrame(() => {
        raf = 0
        draw()
      })
    }

    function fitNodes(targets: SimNode[]): void {
      if (targets.length === 0 || width === 0 || height === 0) return
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of targets) {
        const x = n.x ?? 0
        const y = n.y ?? 0
        minX = Math.min(minX, x - n.r)
        minY = Math.min(minY, y - n.r)
        maxX = Math.max(maxX, x + n.r)
        maxY = Math.max(maxY, y + n.r)
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return
      const pad = targets.length === 1 ? 110 : 42
      const boxW = Math.max(1, maxX - minX)
      const boxH = Math.max(1, maxY - minY)
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min((width - pad * 2) / boxW, (height - pad * 2) / boxH)),
      )
      k = next
      tx = width / 2 - ((minX + maxX) / 2) * next
      ty = height / 2 - ((minY + maxY) / 2) * next
      scheduleDraw()
    }

    function selectLocal(id: string | null): void {
      activeIdRef.current = id
      setActiveId(id)
      scheduleDraw()
    }

    function installController(): void {
      controllerRef.current = {
        focusNode(id, opts) {
          const n = nodes.find((node) => node.id === id)
          if (!n) return
          selectLocal(id)
          if (opts?.fit) fitNodes([n])
        },
        fitAll() {
          fitNodes(nodes)
        },
        reset() {
          hovered = null
          selectLocal(null)
          k = 1
          tx = 0
          ty = 0
          sim?.alpha(0.2).restart()
          scheduleDraw()
        },
      }
    }

    async function start(): Promise<void> {
      let payload: GraphPayload
      try {
        const res = await fetch('/api/graph')
        if (!res.ok) throw new Error(String(res.status))
        payload = (await res.json()) as GraphPayload
      } catch {
        if (!disposed) setState('error')
        return
      }
      if (disposed) return
      setGraph(payload)
      if (payload.nodes.length === 0) {
        setState('empty')
        return
      }
      setState('ready')
      resize()

      nodes = payload.nodes.map((n) => ({ ...n, r: nodeRadius(n.degree) }))
      links = payload.links.map((l) => ({ source: l.source, target: l.target }))
      for (const l of payload.links) {
        if (!neighbors.has(l.source)) neighbors.set(l.source, new Set())
        if (!neighbors.has(l.target)) neighbors.set(l.target, new Set())
        neighbors.get(l.source)!.add(l.target)
        neighbors.get(l.target)!.add(l.source)
      }
      topByDegree = new Set(
        [...nodes].sort((a, b) => b.degree - a.degree).slice(0, TOP_LABELS).map((n) => n.id),
      )

      sim = forceSimulation<SimNode>(nodes)
        .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(60))
        .force('charge', forceManyBody().strength(-180))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collide', forceCollide<SimNode>((d) => d.r + 2))
        .alphaDecay(0.035)
        .on('tick', scheduleDraw)

      installController()

      let dragNode: SimNode | null = null
      let panning = false
      let moved = false
      let downX = 0
      let downY = 0

      function setCursor(): void {
        canvas!.style.cursor = hovered ? 'pointer' : 'default'
      }

      function onPointerDown(e: PointerEvent): void {
        canvas!.setPointerCapture(e.pointerId)
        downX = e.offsetX
        downY = e.offsetY
        moved = false
        const hit = hitTest(e.offsetX, e.offsetY)
        if (hit) {
          dragNode = hit
        } else {
          panning = true
        }
      }

      function onPointerMove(e: PointerEvent): void {
        if (dragNode) {
          if (!moved && Math.hypot(e.offsetX - downX, e.offsetY - downY) > 3) {
            moved = true
            sim!.alphaTarget(0.3).restart()
          }
          if (moved) {
            const w = toWorld(e.offsetX, e.offsetY)
            dragNode.fx = w.x
            dragNode.fy = w.y
            scheduleDraw()
          }
          return
        }
        if (panning) {
          moved = true
          tx += e.movementX
          ty += e.movementY
          scheduleDraw()
          return
        }
        const hit = hitTest(e.offsetX, e.offsetY)
        if (hit !== hovered) {
          hovered = hit
          setCursor()
          scheduleDraw()
        }
      }

      function onPointerUp(e: PointerEvent): void {
        if (dragNode) {
          if (moved) {
            dragNode.fx = null
            dragNode.fy = null
            sim!.alphaTarget(0)
          } else {
            selectLocal(dragNode.id)
          }
          dragNode = null
        }
        panning = false
        if (canvas!.hasPointerCapture(e.pointerId)) canvas!.releasePointerCapture(e.pointerId)
      }

      function onPointerLeave(): void {
        if (hovered) {
          hovered = null
          setCursor()
          scheduleDraw()
        }
      }

      function onDoubleClick(e: MouseEvent): void {
        const hit = hitTest(e.offsetX, e.offsetY)
        if (hit && hit.group !== 'placeholder') {
          router.push('/?path=' + encodeURIComponent(hit.id))
        }
      }

      function onWheel(e: WheelEvent): void {
        e.preventDefault()
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * Math.exp(-e.deltaY * 0.002)))
        if (next === k) return
        tx = e.offsetX - ((e.offsetX - tx) * next) / k
        ty = e.offsetY - ((e.offsetY - ty) * next) / k
        k = next
        scheduleDraw()
      }

      function onResize(): void {
        resize()
        sim!.force('center', forceCenter(width / 2, height / 2))
        sim!.alpha(0.3).restart()
        scheduleDraw()
      }

      const themeObserver = new MutationObserver(() => {
        refreshTheme()
        scheduleDraw()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      })

      canvas!.addEventListener('pointerdown', onPointerDown)
      canvas!.addEventListener('pointermove', onPointerMove)
      canvas!.addEventListener('pointerup', onPointerUp)
      canvas!.addEventListener('pointerleave', onPointerLeave)
      canvas!.addEventListener('dblclick', onDoubleClick)
      canvas!.addEventListener('wheel', onWheel, { passive: false })
      window.addEventListener('resize', onResize)
      cleanups.push(() => {
        themeObserver.disconnect()
        canvas!.removeEventListener('pointerdown', onPointerDown)
        canvas!.removeEventListener('pointermove', onPointerMove)
        canvas!.removeEventListener('pointerup', onPointerUp)
        canvas!.removeEventListener('pointerleave', onPointerLeave)
        canvas!.removeEventListener('dblclick', onDoubleClick)
        canvas!.removeEventListener('wheel', onWheel)
        window.removeEventListener('resize', onResize)
      })

      scheduleDraw()
      requestAnimationFrame(() => fitNodes(nodes))
    }

    void start()

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      sim?.stop()
      controllerRef.current = null
      for (const fn of cleanups) fn()
    }
  }, [router])

  const ready = state === 'ready'
  const resultLabel =
    query.trim() === ''
      ? `${sortedNodes.length} nodes`
      : `${filteredNodes.length} of ${sortedNodes.length} nodes`

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'stretch',
        minHeight: 320,
      }}
    >
      <aside
        aria-label="Graph nodes"
        style={{
          flex: '1 1 280px',
          maxWidth: 340,
          minWidth: 240,
          borderRight: '1px solid var(--line)',
          padding: '18px 16px',
          maxHeight: 'calc(100vh - 70px)',
          overflow: 'auto',
        }}
      >
        <label className="lbl" htmlFor="graph-node-search">
          Search nodes
        </label>
        <input
          id="graph-node-search"
          className="searchin"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filteredNodes[0]) {
              e.preventDefault()
              focusNode(filteredNodes[0].id)
            }
          }}
          placeholder="Title, path, or type"
          disabled={!ready}
          aria-describedby="graph-node-count"
          style={{ marginTop: 8 }}
        />
        <p id="graph-node-count" className="connect-sub sub" aria-live="polite">
          {state === 'loading' ? 'Loading graph...' : resultLabel}
        </p>

        <div style={{ display: 'flex', gap: 8, margin: '12px 0 14px' }}>
          <button
            type="button"
            className="kbd"
            onClick={() => controllerRef.current?.fitAll()}
            disabled={!ready}
          >
            Fit
          </button>
          <button
            type="button"
            className="kbd"
            onClick={() => {
              setQuery('')
              controllerRef.current?.reset()
            }}
            disabled={!ready}
          >
            Reset
          </button>
        </div>

        {state === 'error' ? (
          <p className="memempty" role="status">
            Couldn't load the graph. Reload to try again.
          </p>
        ) : null}
        {state === 'empty' ? (
          <p className="memempty" role="status">
            Nothing linked yet. Write some <code>[[wikilinks]]</code>.
          </p>
        ) : null}

        {ready ? (
          <ul className="memlist" aria-label="Node list">
            {filteredNodes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`noteitem${activeId === n.id ? ' cur' : ''}`}
                  onClick={() => focusNode(n.id)}
                  aria-pressed={activeId === n.id}
                  title={n.id}
                  style={{ width: '100%', display: 'block' }}
                >
                  <span style={{ display: 'block', fontWeight: 600 }}>{n.title}</span>
                  <span className="memmeta">
                    {groupLabel(n.group)} · {n.degree} links
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <section aria-label="Selected node" style={{ marginTop: 18 }}>
          <span className="lbl">Neighbors</span>
          {activeNode ? (
            <>
              <h2 className="memtitle" style={{ marginTop: 10 }}>
                {activeNode.title}
              </h2>
              <p className="connect-sub sub">
                {groupLabel(activeNode.group)} · {activeNode.degree} links
              </p>
              {activeNode.group !== 'placeholder' ? (
                <button
                  type="button"
                  className="histundo"
                  onClick={() => openNode(activeNode.id)}
                  style={{ margin: '8px 0 12px' }}
                >
                  Open note
                </button>
              ) : (
                <p className="connect-sub sub">This is an uncreated wikilink target.</p>
              )}
              {activeNeighbors.length > 0 ? (
                <ul className="memlist" aria-label={`Neighbors of ${activeNode.title}`}>
                  {activeNeighbors.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="noteitem"
                        onClick={() => focusNode(n.id)}
                        title={n.id}
                        style={{ width: '100%', display: 'block' }}
                      >
                        <span style={{ display: 'block', fontWeight: 600 }}>{n.title}</span>
                        <span className="memmeta">
                          {groupLabel(n.group)} · {n.degree} links
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="connect-sub sub">No linked neighbors yet.</p>
              )}
            </>
          ) : (
            <p className="connect-sub sub">Choose a node to inspect its linked neighbors.</p>
          )}
        </section>
      </aside>

      <div
        ref={containerRef}
        className="graphwrap"
        style={{
          flex: '4 1 360px',
          minWidth: 0,
        }}
      >
        {ready ? (
          <div className="graphlegend mono" aria-hidden="true">
            <span className="graphchip">
              <i className="graphdot graphdot-memory" /> memory
            </span>
            <span className="graphchip">
              <i className="graphdot graphdot-note" /> note
            </span>
            <span className="graphchip">
              <i className="graphdot graphdot-hollow" /> uncreated
            </span>
          </div>
        ) : null}
        <canvas ref={canvasRef} className="graphcanvas" aria-hidden="true" />
      </div>
    </div>
  )
}
