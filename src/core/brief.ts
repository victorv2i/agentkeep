import { Vault } from './vault.js'
import { WriteCore } from './write-core.js'
import { Indexer } from './indexer.js'
import { listTasks, type Task } from './task.js'
import { loadPendingProposals, type Proposal } from './proposal.js'
import { readNorthStar } from './north-star.js'
import { parseNote } from './parse.js'

export interface BriefDeps {
  vault: Vault
  core: WriteCore
  indexer: Indexer
}

export interface Connection {
  /** Human TITLE of the source note that links to `to` (never a slug/path). */
  from: string
  /** Human TITLE of the active note the link points at (never a slug/path). */
  to: string
  /** Plain, factual one-liner about the edge — no fake insight (the LLM does that). */
  why: string
  /** Cite-source ref (DESIGN §9: claims cite their source) — the `from` path. */
  source: string
}

/** A backlink edge as raw vault PATHS, before title resolution. */
interface ConnectionEdge {
  from: string
  to: string
}

export interface WhatMatters {
  goal: string
  items: Task[]
}

export interface BriefData {
  date: string
  loopsClosedOvernight: number
  needYou: number
  today: Task[]
  whatMatters: WhatMatters[]
  oneConnection: Connection | null
  needsYourEyes: Proposal[]
}

const PRIORITY_RANK: Record<string, number> = { high: 3, med: 2, low: 1 }

/**
 * Total order: priority desc (high>med>low>none), then title asc, then id —
 * id tiebreak + pinned locale keep the brief byte-identical across hosts
 * (unpinned localeCompare drifts with the runtime ICU/locale).
 */
function byPriorityThenTitle(a: Task, b: Task): number {
  const pa = PRIORITY_RANK[a.priority ?? ''] ?? 0
  const pb = PRIORITY_RANK[b.priority ?? ''] ?? 0
  if (pa !== pb) return pb - pa
  const t = a.title.localeCompare(b.title, 'en')
  return t !== 0 ? t : a.id.localeCompare(b.id, 'en')
}

// Common short words that should not drive goal→task matching. Keeping this list
// tiny and explicit is deliberate (deterministic, no NLP); the LLM version does
// real relevance instead of word overlap.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
  'my', 'your', 'it', 'is', 'be', 'do', 'more', 'less',
])

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

/** Does this task reference any significant word of the goal (title or tags)? */
function taskMatchesGoal(task: Task, goalWords: string[]): boolean {
  const hay = new Set([
    ...significantWords(task.title),
    ...(task.tags ?? []).flatMap(significantWords),
  ])
  return goalWords.some((w) => hay.has(w))
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '').toLowerCase()
}

/**
 * Generate the Morning Brief DATA (DESIGN §8) — fully deterministic, offline. The
 * date is passed in; nothing here reads the wall clock.
 *
 * Heuristics (deterministic; a connected agent can write a richer brief itself):
 *
 * - loopsClosedOvernight: counts tasks with `status:'done'`. If a task carries a
 *   `closedAt` AND a `sinceISO` window is given, only closes at/after the window
 *   count (the real "overnight" set); otherwise we count all done (simple, honest
 *   default). LLM later: diff the git log over the window instead of a snapshot.
 *
 * - oneConnection: the smallest sensible backlink surfacer. "Active" notes are the
 *   title-notes of `today`/`doing` tasks (matched by basename in the link graph).
 *   For the first such note (sorted, stable), we return its first backlink whose
 *   source is not itself active — a real edge into something on your plate you
 *   might forget the origin of. The edge is found by path, then resolved to the
 *   notes' human TITLES so nothing user-facing leaks a slug. The deterministic
 *   prose is plainly factual ("these two notes are linked"), never fake-insightful
 *   — the genuinely-insightful version is the LLM's job later.
 */
export async function generateBrief(
  deps: BriefDeps,
  opts: { date: string; sinceISO?: string },
): Promise<BriefData> {
  const tasks = await listTasks(deps.vault)
  const pending = await loadPendingProposals(deps.vault)
  const { goals } = await readNorthStar(deps.core)

  const done = tasks.filter((t) => t.status === 'done')
  const loopsClosedOvernight =
    opts.sinceISO === undefined
      ? done.length
      : done.filter((t) => t.closedAt === undefined || t.closedAt >= opts.sinceISO!).length

  const today = dedupeById(
    tasks.filter((t) => t.status === 'today' || t.due === opts.date),
  ).sort(byPriorityThenTitle)

  const whatMatters: WhatMatters[] = []
  for (const goal of goals) {
    const words = significantWords(goal.text)
    if (words.length === 0) continue
    const items = tasks.filter((t) => taskMatchesGoal(t, words)).sort(byPriorityThenTitle)
    if (items.length > 0) whatMatters.push({ goal: goal.text, items })
    if (whatMatters.length === 3) break
  }

  const edge = findOneConnection(deps.indexer, tasks)
  const oneConnection = edge === null ? null : await resolveConnection(deps.core, edge)

  return {
    date: opts.date,
    loopsClosedOvernight,
    needYou: pending.length,
    today,
    whatMatters,
    oneConnection,
    needsYourEyes: pending,
  }
}

function dedupeById(tasks: Task[]): Task[] {
  const seen = new Set<string>()
  const out: Task[] = []
  for (const t of tasks) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

function findOneConnection(indexer: Indexer, tasks: Task[]): ConnectionEdge | null {
  // Active titles = title-notes of today/doing tasks (the things on your plate),
  // lowercased to match a note by Obsidian-style basename.
  const activeTitles = new Set(
    tasks
      .filter((t) => t.status === 'today' || t.status === 'doing')
      .map((t) => t.title.toLowerCase()),
  )
  if (activeTitles.size === 0) return null

  // The active note PATHS the index actually knows: an indexed note whose
  // basename is an active title. Both ends of an edge must be indexed for a
  // backlink to exist, so resolving titles → real paths here keeps it correct.
  const activeNotePaths = indexer
    .notePaths()
    .filter((p) => activeTitles.has(basenameNoExt(p)))
  const activeSet = new Set(activeNotePaths)

  for (const to of activeNotePaths) {
    for (const from of indexer.getBacklinks(to).sort()) {
      if (activeSet.has(from)) continue // both ends active — not a "missed" edge
      return { from, to }
    }
  }
  return null
}

/** Resolve a backlink edge (paths) into a Connection that uses note TITLES. */
async function resolveConnection(core: WriteCore, edge: ConnectionEdge): Promise<Connection> {
  const fromTitle = await noteTitle(core, edge.from)
  const toTitle = await noteTitle(core, edge.to)
  return {
    from: fromTitle,
    to: toTitle,
    // Plain and factual — the deterministic version only knows "these are linked".
    why: `You linked ${toTitle} from ${fromTitle}.`,
    source: edge.from,
  }
}

/**
 * The note's human title: frontmatter `title` ?? first `# H1` ?? basename
 * without extension (same precedence as `parseNote`). Falls back to the
 * basename only if the note can't be read — never the full slug path.
 */
async function noteTitle(core: WriteCore, relPath: string): Promise<string> {
  const r = await core.read(relPath)
  if (r === null) return slug(relPath)
  return parseNote(relPath, r.content).title
}

function slug(relPath: string): string {
  return relPath.split('/').pop()?.replace(/\.md$/i, '') ?? relPath
}

/**
 * One Today line. A done task gets a checked box; the agent attribution is added
 * ONLY when the close is recorded as the agent's (`closedBy === 'agent'`) — a
 * task closed by the human (or with no recorded closer) must never claim the
 * agent did it (no-slop: don't out-claim what the engine recorded).
 */
function renderTodayItem(t: Task): string {
  if (t.status !== 'done') return `- [ ] ${t.title}`
  const attribution = t.closedBy === 'agent' ? ' — closed by your agent' : ''
  return `- [x] ${t.title}${attribution}`
}

/** Render the brief DATA into the one opinionated markdown format (DESIGN §8). */
export function renderBrief(data: BriefData): string {
  const lines: string[] = []
  lines.push(`# ${data.loopsClosedOvernight} loops closed overnight · ${data.needYou} need you`)
  lines.push('')

  lines.push('## Today')
  if (data.today.length === 0) {
    lines.push('Nothing due — clear deck.')
  } else {
    for (const t of data.today) lines.push(renderTodayItem(t))
  }
  lines.push('')

  if (data.whatMatters.length > 0) {
    lines.push('## What matters')
    for (const w of data.whatMatters) {
      lines.push(`### ${w.goal}`)
      for (const t of w.items) lines.push(`- ${t.title}`)
    }
    lines.push('')
  }

  if (data.oneConnection) {
    const c = data.oneConnection
    lines.push("## One connection you'd have missed")
    lines.push(c.why)
    lines.push(`cites: [[${slug(c.source)}]]`)
    lines.push('')
  }

  if (data.needsYourEyes.length > 0) {
    lines.push('## Needs your eyes')
    for (const p of data.needsYourEyes) lines.push(`- ${p.summary}`)
    lines.push('')
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}

/**
 * Generate → render → write the brief to `brief/<date>.md` as `author:'agent'`.
 * Reads the current file first for the CAS baseHash, so a same-day re-run is a
 * clean overwrite (no ConflictError) rather than an expect-create collision.
 */
export async function runMorningBrief(
  deps: BriefDeps,
  opts: { date: string; sinceISO?: string },
): Promise<{ path: string; data: BriefData }> {
  const data = await generateBrief(deps, opts)
  const md = renderBrief(data)
  const path = `brief/${opts.date}.md`
  const current = await deps.core.read(path)
  await deps.core.write(path, md, { author: 'agent', baseHash: current?.hash ?? null })
  return { path, data }
}
