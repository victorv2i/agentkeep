'use client'

import { useEffect, useRef, useState } from 'react'
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
 * Full-viewport force-directed graph of the vault, hand-rolled on <canvas>.
 *
 * The graph stays flat: flat filled circles, 1px edges, no shadows /
 * gradients / glow — hover de-emphasis is plain globalAlpha. d3-force (ISC)
 * runs the simulation; everything on screen is drawn by `draw()` below.
 *
 * Render scheduling: the sim's own internal timer drives ticks while hot; each
 * tick (and each interaction) requests at most ONE animation frame. When the
 * sim cools there are no ticks → no frames → zero idle CPU. Dragging a node
 * re-heats it (alphaTarget 0.3), releasing lets it settle again.
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

const MIN_SCALE = 0.2
const MAX_SCALE = 4
/** Zoom level past which the top-degree labels appear. */
const LABEL_ZOOM = 1.2
/** How many highest-degree nodes get an always-on label when zoomed in. */
const TOP_LABELS = 25

function nodeRadius(degree: number): number {
  return Math.min(14, Math.max(3, 3 + Math.sqrt(degree) * 2))
}

function linkEndId(end: SimLink['source']): string {
  // d3 forceLink rewrites string endpoints into node objects on init.
  return typeof end === 'object' ? (end as SimNode).id : String(end)
}

export function GraphClient() {
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'empty' | 'error' | 'ready'>('loading')

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

    // Resolve the shell's mono font AND the theme colors once from CSS vars,
    // so the canvas matches whichever theme (dark/light) is active. A fresh
    // render after a theme switch picks up the new values.
    const cs = getComputedStyle(document.body)
    const cssVar = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
    const monoFamily = cssVar('--font-mono', 'monospace')
    const EDGE = cssVar('--line-2', '#2A2B30')
    const MEMORY_FILL = cssVar('--acc', '#A6C0FF')
    const NOTE_FILL = cssVar('--mut', '#C9CAD1')
    const HOLLOW_STROKE = cssVar('--faint', '#8A8B92')
    const LABEL = cssVar('--mut', '#8A8B92')

    // ── viewport ──────────────────────────────────────────────────────────
    let width = 0
    let height = 0
    function resize(): void {
      const rect = container!.getBoundingClientRect()
      width = container!.clientWidth
      // Fill the rest of the viewport below the shell chrome (topbar above us).
      height = Math.max(320, window.innerHeight - rect.top)
      const dpr = window.devicePixelRatio || 1
      canvas!.width = Math.round(width * dpr)
      canvas!.height = Math.round(height * dpr)
      canvas!.style.width = `${width}px`
      canvas!.style.height = `${height}px`
    }

    // ── camera + interaction state ────────────────────────────────────────
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

    function isNeighbor(n: SimNode): boolean {
      if (!hovered) return true
      if (n.id === hovered.id) return true
      return neighbors.get(hovered.id)?.has(n.id) ?? false
    }

    // ── render (flat: fills, 1px strokes, plain alpha — nothing else) ─────
    function draw(): void {
      const dpr = window.devicePixelRatio || 1
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, width, height)
      ctx!.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty)

      // edges
      ctx!.lineWidth = 1 / k
      ctx!.strokeStyle = EDGE
      for (const l of links) {
        const s = l.source as SimNode
        const t = l.target as SimNode
        const lit = !hovered || s.id === hovered.id || t.id === hovered.id
        ctx!.globalAlpha = lit ? 1 : 0.25
        ctx!.beginPath()
        ctx!.moveTo(s.x ?? 0, s.y ?? 0)
        ctx!.lineTo(t.x ?? 0, t.y ?? 0)
        ctx!.stroke()
      }

      // nodes
      for (const n of nodes) {
        ctx!.globalAlpha = isNeighbor(n) ? 1 : 0.25
        ctx!.beginPath()
        ctx!.arc(n.x ?? 0, n.y ?? 0, n.r, 0, Math.PI * 2)
        if (n.group === 'placeholder') {
          ctx!.lineWidth = 1 / k
          ctx!.strokeStyle = HOLLOW_STROKE
          ctx!.stroke()
        } else {
          ctx!.fillStyle = n.group === 'memory' ? MEMORY_FILL : NOTE_FILL
          ctx!.fill()
        }
      }

      // labels — after nodes; hovered+neighbors always, top-degree when zoomed
      ctx!.font = `${10 / k}px ${monoFamily}`
      ctx!.fillStyle = LABEL
      ctx!.textBaseline = 'middle'
      for (const n of nodes) {
        const hoverLabel = hovered && (n.id === hovered.id || isNeighbor(n))
        const zoomLabel = k > LABEL_ZOOM && topByDegree.has(n.id)
        if (!hoverLabel && !zoomLabel) continue
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

    // ── load + simulate ───────────────────────────────────────────────────
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
        .alphaDecay(0.035) // settles in ≈3s; the tick stream (→ frames) stops with it
        .on('tick', scheduleDraw)

      // ── pointer interaction ─────────────────────────────────────────────
      let dragNode: SimNode | null = null
      let panning = false
      let moved = false
      let downX = 0
      let downY = 0

      function setCursor(): void {
        canvas!.style.cursor =
          hovered && hovered.group !== 'placeholder' ? 'pointer' : 'default'
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
            sim!.alphaTarget(0.3).restart() // re-heat while dragging
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
            sim!.alphaTarget(0) // let it settle (and the frames stop) again
          } else if (dragNode.group !== 'placeholder') {
            // a clean click on a note/memory node opens it in the vault
            router.push('/?path=' + encodeURIComponent(dragNode.id))
          }
          dragNode = null
        }
        panning = false
        canvas!.releasePointerCapture(e.pointerId)
      }

      function onPointerLeave(): void {
        if (hovered) {
          hovered = null
          setCursor()
          scheduleDraw()
        }
      }

      function onWheel(e: WheelEvent): void {
        e.preventDefault()
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * Math.exp(-e.deltaY * 0.002)))
        if (next === k) return
        // cursor-anchored: the world point under the pointer stays put
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

      canvas!.addEventListener('pointerdown', onPointerDown)
      canvas!.addEventListener('pointermove', onPointerMove)
      canvas!.addEventListener('pointerup', onPointerUp)
      canvas!.addEventListener('pointerleave', onPointerLeave)
      canvas!.addEventListener('wheel', onWheel, { passive: false })
      window.addEventListener('resize', onResize)
      cleanups.push(() => {
        canvas!.removeEventListener('pointerdown', onPointerDown)
        canvas!.removeEventListener('pointermove', onPointerMove)
        canvas!.removeEventListener('pointerup', onPointerUp)
        canvas!.removeEventListener('pointerleave', onPointerLeave)
        canvas!.removeEventListener('wheel', onWheel)
        window.removeEventListener('resize', onResize)
      })

      scheduleDraw()
    }

    void start()

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      sim?.stop()
      for (const fn of cleanups) fn()
    }
  }, [router])

  return (
    <div ref={containerRef} className="graphwrap">
      {state === 'ready' ? (
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
      {state === 'empty' ? (
        <p className="graphempty">Nothing linked yet. Write some [[wikilinks]].</p>
      ) : null}
      {state === 'error' ? (
        <p className="graphempty">Couldn’t load the graph. Reload to try again.</p>
      ) : null}
      <canvas ref={canvasRef} className="graphcanvas" aria-label="Vault link graph" />
    </div>
  )
}
