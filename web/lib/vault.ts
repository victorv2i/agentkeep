import 'server-only'

import path from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import {
  openVault,
  Indexer,
  VaultWatcher,
  parseNote,
  displayTitle,
  isCaptureBasename,
  readNote,
  getMaker,
  runAgentOnce,
  approve as approveProposalCore,
  dismissProposal as dismissProposalCore,
  loadPendingProposals,
  captureToInbox,
  VaultPathError,
  type Agentkeep,
  type Author,
  type HistoryEntry,
} from '@agentkeep/core'
import { readVaultState, writeActiveVault } from './vault-state'
import { isContentPath, isNotePath } from './content-path'
import { agentActionLabel } from './agent-activity'
import { excerptOf } from './excerpt'

/**
 * Server-only data layer that bridges the web app to the Agentkeep core.
 *
 * The core is an ESM Node library that does fs + git (simple-git, chokidar,
 * write-file-atomic). It must NEVER reach the browser bundle — `import
 * 'server-only'` at the top makes any client-component import a build error.
 *
 * We open the vault and build the derived index exactly once per server
 * process, memoized on a module-level promise (App Router server modules are
 * singletons within a worker). `reindexAll()` reconstructs the link graph +
 * search index from the markdown on disk so search + backlinks have real data
 * to work with.
 */

/**
 * The default vault root when no in-UI vault has been chosen: AGENTKEEP_VAULT env,
 * else the seeded ./dev-vault. This preserves the original behavior — a fresh
 * install with no state file serves exactly what it did before.
 */
export function defaultVaultRoot(): string {
  const env = process.env.AGENTKEEP_VAULT
  if (env && env.trim() !== '') return path.resolve(env)
  // Default for dev: the seeded vault at the repo root (one level above web/).
  return path.resolve(process.cwd(), '..', 'dev-vault')
}

/**
 * Resolve the ACTIVE vault root: the in-UI active vault from persisted state if
 * one has been chosen, else the default (env → dev-vault). State wins so an
 * in-app "Open a vault" survives restarts; with no state file the default path
 * applies unchanged.
 */
export async function vaultRoot(): Promise<string> {
  const state = await readVaultState()
  if (state.activeVault && state.activeVault.trim() !== '') {
    return path.resolve(state.activeVault)
  }
  return defaultVaultRoot()
}

export interface VaultHandle {
  app: Agentkeep
  indexer: Indexer
  watcher: VaultWatcher
  root: string
}

// Pinned to globalThis (not a module-level `let`) so Next dev HMR — which
// re-evaluates this module on every hot-reload — reuses the SAME vault handle
// instead of starting a second chokidar watcher each time (the old one would
// never stop). NOTE: the live index assumes a single server process — Agentkeep
// is single-user self-host, so there is exactly one watcher per vault.
const vaultGlobal = globalThis as typeof globalThis & {
  __agentkeepVault?: Promise<VaultHandle>
}

/**
 * Open the vault + build the index once (memoized for the process lifetime), and
 * start a VaultWatcher on the same indexer so external file writes re-index LIVE.
 *
 * This is what makes a file-only agent (Hermes, or Obsidian itself) "plug in":
 * when it writes a `.md` straight to the vault while the app is running, chokidar
 * fires and the indexer picks it up — search/backlinks see it without a
 * restart. The app's OWN writes already index themselves through the write-core,
 * so we hand the watcher `core.isSelfWrite` to skip re-indexing those (no
 * double-work, no churn on every editor save).
 *
 * If the open/index/watch fails we DROP the cached promise so the next request
 * retries — a one-time failure (e.g. a missing vault at boot) must not poison the
 * whole app forever with a permanently-rejected memo.
 */
export function getVault(): Promise<VaultHandle> {
  if (!vaultGlobal.__agentkeepVault) {
    vaultGlobal.__agentkeepVault = openAndWatch().catch((e) => {
      vaultGlobal.__agentkeepVault = undefined
      throw e
    })
  }
  return vaultGlobal.__agentkeepVault
}

async function openAndWatch(): Promise<VaultHandle> {
  const root = await vaultRoot()
  // Create the vault folder if it doesn't exist yet, so a fresh clone (or
  // pointing AGENTKEEP_VAULT at a new path) opens an empty vault instead of
  // crashing: the seeded ./dev-vault default is gitignored, so a cloner has no
  // such dir, and openVault → git on a missing dir would 500 every page.
  await mkdir(root, { recursive: true })
  const app = await openVault(root)
  const indexer = new Indexer(app.vault)
  await indexer.reindexAll()
  const watcher = new VaultWatcher(app.vault, indexer, {
    isSelfWrite: (relPath, hash) => app.core.isSelfWrite(relPath, hash),
  })
  await watcher.start()
  return { app, indexer, watcher, root }
}

export type SetVaultResult =
  | { ok: true; root: string }
  | { ok: false; error: string }

/**
 * Point the app at a different vault folder and switch to it LIVE — no restart.
 *
 * Validates the path is an existing DIRECTORY (a file or missing path gets a
 * friendly error, never a crash), `openVault`s it (which safely git-inits +
 * writes a default `.gitignore` so nothing of the user's Obsidian config is
 * committed), persists it as the active vault + pushes it to recents, then tears
 * down the old vault handle: the previous VaultWatcher's chokidar is STOPPED and
 * the `globalThis` memo is CLEARED, so the very next `getVault()` rebuilds the
 * index + starts a fresh watcher rooted at the new folder. Without that teardown
 * the app would keep serving the old vault's index and leak the old watcher.
 */
export async function setActiveVault(rawPath: string): Promise<SetVaultResult> {
  const input = (rawPath ?? '').trim()
  if (input === '') return { ok: false, error: 'Enter the absolute path to a vault folder.' }
  if (!path.isAbsolute(input)) {
    return { ok: false, error: 'Use an absolute path (e.g. /home/you/MyVault).' }
  }
  const root = path.resolve(input)

  const { stat } = await import('node:fs/promises')
  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      return { ok: false, error: 'That path is a file, not a folder. Point at the vault folder.' }
    }
  } catch {
    return { ok: false, error: 'No folder at that path. Check it and try again.' }
  }

  // Open it through the core (git-init + .gitignore guard + baseline snapshot).
  try {
    await openVault(root)
  } catch (err) {
    return { ok: false, error: `Couldn’t open that folder as a vault: ${(err as Error).message}` }
  }

  // The vault we're switching away from (the live root, possibly the env/dev
  // default that was never explicitly opened) — folded into recents below so
  // there's always a one-click way back.
  const previousRoot = await vaultRoot()

  // Persist BEFORE swapping the live handle so a restart lands on the new vault
  // even if the teardown below were interrupted.
  await writeActiveVault(root, previousRoot)

  // Tear down the current live handle (if any): stop its watcher, drop the memo.
  const pending = vaultGlobal.__agentkeepVault
  vaultGlobal.__agentkeepVault = undefined
  if (pending) {
    try {
      const old = await pending
      await old.watcher.stop()
    } catch {
      // A never-resolved/old handle — nothing to stop. The cleared memo is enough.
    }
  }

  // Warm the new handle now so the first request after the switch is fast and so
  // any open error surfaces here rather than on the next page load.
  await getVault()
  return { ok: true, root }
}

export interface ActiveVaultInfo {
  /** Absolute path of the vault currently being served. */
  activePath: string
  /** Recently-opened vaults (newest first), for the quick-switch buttons. */
  recentVaults: string[]
}

/** Current active vault path + recents, for the Settings "Vault" section. */
export async function getActiveVaultInfo(): Promise<ActiveVaultInfo> {
  const [{ root }, state] = await Promise.all([getVault(), readVaultState()])
  return { activePath: root, recentVaults: state.recentVaults }
}

// ── Connect-your-agent facts (Settings page) ─────────────────────────────────
// Everything the "Connect your agent" page shows is RESOLVED here from the real
// environment — the actual vault path, the real `agentkeep-mcp` bin if it's been
// built/linked, and whether the BYO key is set. No invented placeholders: if a
// value can't be resolved we say so honestly rather than printing a fake one.

export interface ConnectFacts {
  /** Absolute vault path the app is actually serving. */
  vaultPath: string
  /**
   * Absolute path to the built `agentkeep-mcp` launcher if it resolves on disk
   * (the pnpm/npm bin symlink), else null — meaning it hasn't been built yet.
   */
  binPath: string | null
}

/**
 * Resolve the real connection facts for the Settings page: the BYO-agent seam
 * (the connected agent reasons over the vault via MCP). Agentkeep needs no API
 * key of its own.
 */
export async function getConnectFacts(): Promise<ConnectFacts> {
  const vaultPath = await vaultRoot()

  // The bin is `dist/bin/agentkeep-mcp.js`, exposed as the `agentkeep-mcp`
  // command. Prefer the workspace symlink (what a user running from this repo
  // gets); fall back to the compiled file. Either is a real, runnable path.
  let binPath: string | null = null
  const { access } = await import('node:fs/promises')
  const repoRoot = path.resolve(process.cwd(), '..')
  const candidates = [
    path.join(repoRoot, 'node_modules', '.bin', 'agentkeep-mcp'),
    path.join(repoRoot, 'dist', 'bin', 'agentkeep-mcp.js'),
  ]
  for (const c of candidates) {
    try {
      await access(c)
      binPath = c
      break
    } catch {
      // not present — try the next candidate
    }
  }
  return { vaultPath, binPath }
}

/**
 * The owner's display name for the greeting + rail. Reads an optional `user` key
 * from `.agentkeep/config.json`; falls back to the OS user, else "you".
 */
export async function getUser(): Promise<string> {
  const { app } = await getVault()
  try {
    const r = await app.core.read('.agentkeep/config.json')
    if (r) {
      const cfg = JSON.parse(r.content) as { user?: string }
      if (typeof cfg.user === 'string' && cfg.user.trim() !== '') return cfg.user.trim()
    }
  } catch {
    // Missing/corrupt config → fall through to the default.
  }
  return process.env.USER || process.env.USERNAME || 'you'
}

// ── Notes editor data layer ──────────────────────────────────────────────────
// These power the vault-home editor. Everything goes through the SAME WriteCore the
// agent uses (the single write seam) — loads return a content hash, saves echo
// it as `baseHash` for the content-hash compare-and-swap (the two-driver
// guarantee). Titles are human (frontmatter title ?? first H1 ?? humanized
// filename — see core displayTitle), never raw slugs/paths in the UI.

export interface NoteListItem {
  /** Vault-relative path — the stable key the editor loads/saves by. */
  path: string
  /** Human display title (frontmatter title ?? first H1 ?? humanized filename). */
  title: string
  /** Basename without `.md` — the Obsidian `[[basename]]` autocomplete target. */
  basename: string
  /** The real path, surfaced as a hover tooltip when the title is derived for a
   * quick capture (`cap_<hex>`) — the humanized title never hides the file. */
  tooltip?: string
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

/** All markdown notes by human title + basename, sorted by title (case-fold). */
export async function listNotes(): Promise<NoteListItem[]> {
  const { app } = await getVault()
  const paths = await app.vault.listMarkdown()
  const items: NoteListItem[] = []
  for (const p of paths) {
    const basename = basenameNoExt(p)
    let raw: string | null = null
    try {
      raw = (await app.core.read(p))?.content ?? null
    } catch {
      // Unreadable/odd file — displayTitle falls back to the humanized filename.
    }
    const isCapture = isCaptureBasename(basename)
    let mtime: Date | undefined
    if (isCapture) {
      // A capture with no frontmatter `created` dates its title from file mtime.
      try {
        mtime = (await stat(await app.vault.resolveSafe(p))).mtime
      } catch {
        // Unstattable — displayTitle degrades to a bare "Capture".
      }
    }
    const title = displayTitle(p, raw, { mtime })
    // For captures the title is derived, never the hex id — keep the real path
    // reachable as a tooltip for honesty.
    items.push({ path: p, title, basename, ...(isCapture ? { tooltip: p } : {}) })
  }
  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  return items
}

// ── Graph payload (/api/graph → the /graph canvas) ───────────────────────────

export interface GraphNode {
  /** Note path, or `placeholder:<target>` for an uncreated `[[target]]`. */
  id: string
  /** Human display title (parsed note title; the raw target for placeholders). */
  title: string
  group: 'memory' | 'note' | 'placeholder'
  /** Total deduped edges touching this node. */
  degree: number
}

export interface GraphLink {
  source: string
  target: string
}

export interface GraphPayload {
  nodes: GraphNode[]
  links: GraphLink[]
}

/**
 * The whole vault as a graph, straight from the live LinkGraph: every indexed
 * note is a node (`memory/*` colored as memory), every uncreated `[[target]]`
 * is a hollow placeholder node, and edges are the resolved + unresolved
 * wikilinks — deduped so a↔b appears once. Degree counts deduped edges.
 */
export async function getGraph(): Promise<GraphPayload> {
  const { app, indexer } = await getVault()
  const paths = indexer.notePaths()

  const links: GraphLink[] = []
  const seen = new Set<string>()
  const addEdge = (a: string, b: string): void => {
    if (a === b) return // a self-link draws nothing useful
    const key = a < b ? `${a} ${b}` : `${b} ${a}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({ source: a, target: b })
  }
  for (const p of paths) {
    for (const t of indexer.getLinks(p)) addEdge(p, t)
    for (const raw of indexer.getUnresolved(p)) addEdge(p, `placeholder:${raw}`)
  }

  const degree = new Map<string, number>()
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
  }

  const nodes: GraphNode[] = []
  for (const p of paths) {
    let title = basenameNoExt(p)
    try {
      const r = await app.core.read(p)
      if (r) title = parseNote(p, r.content).title
    } catch {
      // unreadable note — basename title is the honest fallback
    }
    nodes.push({
      id: p,
      title,
      group: p.startsWith('memory/') ? 'memory' : 'note',
      degree: degree.get(p) ?? 0,
    })
  }
  for (const raw of indexer.getPlaceholders()) {
    const id = `placeholder:${raw}`
    nodes.push({ id, title: raw, group: 'placeholder', degree: degree.get(id) ?? 0 })
  }
  return { nodes, links }
}

// ── Memory page data (/memory — "What your agent believes") ──────────────────
// Memory notes are the plain markdown under memory/ (the `remember` tool's
// convention: frontmatter type/source/updated + body). This just READS what's
// on disk — no ranking, no recall scoring; the page shows what is.

export interface MemoryNote {
  path: string
  title: string
  /** Frontmatter `type` when it's one of the known kinds, else 'other'. */
  type: 'fact' | 'preference' | 'person' | 'project' | 'other'
  source?: string
  /** Frontmatter `updated` (YYYY-MM-DD), when present. */
  updated?: string
  /** First non-empty body line, capped ~120 chars. */
  excerpt: string
}

const MEMORY_TYPES = new Set(['fact', 'preference', 'person', 'project'])

/** All notes under memory/, with frontmatter fields + a one-line excerpt. */
export async function getMemoryNotes(): Promise<MemoryNote[]> {
  const { app } = await getVault()
  const paths = (await app.vault.listMarkdown()).filter((p) => p.startsWith('memory/'))
  const items: MemoryNote[] = []
  for (const p of paths) {
    let r
    try {
      r = await app.core.read(p)
    } catch {
      continue // unreadable file — nothing honest to show for it
    }
    if (!r) continue
    const { data, body } = readNote(r.content)
    const rawType = typeof data.type === 'string' ? data.type : ''
    items.push({
      path: p,
      title: parseNote(p, r.content).title,
      type: MEMORY_TYPES.has(rawType) ? (rawType as MemoryNote['type']) : 'other',
      ...(typeof data.source === 'string' && data.source !== '' ? { source: data.source } : {}),
      ...(typeof data.updated === 'string' && data.updated !== '' ? { updated: data.updated } : {}),
      excerpt: excerptOf(body),
    })
  }
  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  return items
}

export interface AgentActivityItem {
  sha: string
  /** Strict-ISO author date. */
  date: string
  /** Human action line: verb + note title, e.g. "Remembered Payee rules". */
  action: string
  /** The path the commit touched, for the link + tooltip (never rendered raw). */
  path?: string
}

/** The agent's last 20 commits (newest first) — the recent-activity feed. */
export async function getAgentActivity(): Promise<AgentActivityItem[]> {
  const { app } = await getVault()
  const commits = await app.git.recentAgentCommits(20)
  const items: AgentActivityItem[] = []
  for (const c of commits) {
    // Resolve the note's human title for a readable action line. A deleted note
    // is gone, so displayTitle falls back to a humanized basename.
    let raw: string | null = null
    if (c.path && /\.md$/i.test(c.path)) {
      try {
        raw = (await app.core.read(c.path))?.content ?? null
      } catch {
        // unreadable / gone — humanized basename is the honest fallback
      }
    }
    const title = c.path ? displayTitle(c.path, raw) : ''
    items.push({
      sha: c.sha,
      date: c.date,
      action: agentActionLabel({ message: c.message, path: c.path, title }),
      ...(c.path ? { path: c.path } : {}),
    })
  }
  return items
}

export interface LoadedNote {
  path: string
  title: string
  content: string
  /** Content hash at load time — the `baseHash` the save CAS is checked against. */
  hash: string
  /** Note paths that link here, by human title (Obsidian basename resolution). */
  backlinks: NoteListItem[]
}

/** Load a note's raw markdown + hash + its backlinks (or null if it's gone). */
export async function loadNote(relPath: string): Promise<LoadedNote | null> {
  // Guard the unauthenticated load action: only ordinary markdown notes, never
  // `.git/`/`.obsidian/`/`.agentkeep/` (resolveSafe permits in-root dotfolders).
  // A rejected path reads as "not found" so it never confirms a file exists.
  if (!isNotePath(relPath)) return null
  const { app, indexer } = await getVault()
  const r = await app.core.read(relPath)
  if (r === null) return null
  const title = parseNote(relPath, r.content).title
  const backlinks = await backlinkItems(indexer.getBacklinks(relPath))
  return { path: relPath, title, content: r.content, hash: r.hash, backlinks }
}

/** Resolve backlink paths to {path,title,basename} items, sorted by title. */
async function backlinkItems(paths: string[]): Promise<NoteListItem[]> {
  const { app } = await getVault()
  const items: NoteListItem[] = []
  for (const p of paths) {
    let title = basenameNoExt(p)
    try {
      const r = await app.core.read(p)
      if (r) title = parseNote(p, r.content).title
    } catch {
      // keep the basename title
    }
    items.push({ path: p, title, basename: basenameNoExt(p) })
  }
  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  return items
}

export type SaveResult =
  | { ok: true; hash: string }
  | { ok: false; conflict: true }

/**
 * Save raw markdown through the WriteCore CAS. `baseHash` is the hash the editor
 * loaded; on a mismatch the core throws ConflictError (someone — likely the
 * agent — changed the file since load) and we report `conflict` instead of
 * clobbering. On success we reindex the one file so backlinks stay live.
 */
export async function saveNote(
  relPath: string,
  content: string,
  baseHash: string | null,
): Promise<SaveResult> {
  // Reject any write that is not an ordinary markdown note. Without this an
  // unauthenticated caller could write `.git/config` (core.fsmonitor) and get
  // code execution on the next git op — resolveSafe alone does not block it.
  if (!isNotePath(relPath)) {
    throw new VaultPathError(`Not an editable note: ${relPath}`)
  }
  const { app, indexer } = await getVault()
  try {
    const { hash } = await app.core.write(relPath, content, {
      author: 'human',
      baseHash,
    })
    await indexer.reindexFile(relPath)
    return { ok: true, hash }
  } catch (err) {
    if ((err as Error).name === 'ConflictError') return { ok: false, conflict: true }
    throw err
  }
}

// ── Per-note provenance (the two-driver vault, made visible) ──────────────────
// Surfaces WHO last touched a note (agent vs you) and its recent history, so the
// moat — every edit git-attributed + reversible — can be felt in the editor.

export interface NoteProvenance {
  /** Author of the note's most recent commit, or null if untracked. */
  lastAuthor: Author | null
  /** ISO date of the most recent commit, or null if untracked. */
  lastEditISO: string | null
  /** Recent commits touching this note, newest first (author already mapped). */
  history: HistoryEntry[]
}

/**
 * The open note's provenance: who last edited it + its recent commit history.
 * Drives the "agent edited" badge and the History/Undo panel. Untracked notes
 * (never committed) come back with null author and empty history — honest, never
 * a fabricated marker.
 */
export async function noteProvenance(relPath: string, limit = 10): Promise<NoteProvenance> {
  // Don't leak git history for non-note paths (e.g. probing `.git/*`).
  if (!isNotePath(relPath)) {
    return { lastAuthor: null, lastEditISO: null, history: [] }
  }
  const { app } = await getVault()
  const history = await app.git.noteHistory(relPath, limit)
  const lastAuthor = await app.git.lastAuthor(relPath)
  return {
    lastAuthor,
    lastEditISO: history[0]?.dateISO ?? null,
    history,
  }
}

export type UndoNoteResult =
  | { ok: true; note: LoadedNote; provenance: NoteProvenance }
  | { ok: false; reason: string }

/**
 * Undo ONE agent-authored commit on a note by SHA (a new inverse `agentkeep-human`
 * commit — history is never rewritten, so the undo is itself reversible). Guards
 * two ways so a human's change is never silently clobbered:
 *   1. the target commit must currently be authored by the AGENT, and
 *   2. that exact SHA must still appear in the note's history.
 * On success it re-reads the note (fresh content + hash) so the editor's CAS
 * stays correct, and returns the refreshed provenance so the panel updates.
 */
export async function undoNoteCommit(relPath: string, sha: string): Promise<UndoNoteResult> {
  if (!isNotePath(relPath)) {
    return { ok: false, reason: 'That is not an editable note.' }
  }
  const { app, indexer } = await getVault()
  const history = await app.git.noteHistory(relPath, 50)
  const target = history.find((h) => h.sha === sha || h.sha.startsWith(sha))
  if (!target) {
    return { ok: false, reason: 'That change is no longer in this note’s history.' }
  }
  if (target.author !== 'agent') {
    return { ok: false, reason: 'Only the agent’s changes can be undone here — not your own.' }
  }
  try {
    await app.git.revertCommit(target.sha)
    await indexer.reindexFile(relPath)
  } catch (err) {
    return { ok: false, reason: `Couldn’t undo cleanly: ${(err as Error).message}` }
  }
  // Re-read so the editor reloads fresh content + hash (CAS stays correct), and
  // hand back the refreshed provenance for the panel.
  const note = await loadNote(relPath)
  if (!note) return { ok: false, reason: 'The note is gone after the undo.' }
  const provenance = await noteProvenance(relPath)
  return { ok: true, note, provenance }
}

/**
 * Resolve a wikilink target (Obsidian basename or full relative path) to an
 * existing note path, or null if it's still a placeholder (uncreated).
 */
export async function resolveTarget(target: string): Promise<string | null> {
  const notes = await listNotes()
  const t = target.replace(/\.md$/i, '').trim()
  if (t === '') return null
  if (t.includes('/')) {
    const withExt = t.toLowerCase().endsWith('.md') ? t : `${t}.md`
    const direct = notes.find((n) => n.path === withExt || n.path === t)
    return direct ? direct.path : null
  }
  const key = t.toLowerCase()
  const matches = notes.filter((n) => n.basename.toLowerCase() === key)
  if (matches.length === 0) return null
  // Deterministic on ambiguity: sorted-first path (matches the core's resolver).
  return matches.map((n) => n.path).sort()[0]!
}

/**
 * Create a new note for a wikilink target (used when a `[[link]]` is unresolved).
 * Writes `notes/<basename>.md` with a minimal H1 from the target, through the
 * write-core. Returns the created path; if a note with that basename already
 * exists it just returns that path (idempotent open-or-create).
 */
export async function createNoteForTarget(target: string): Promise<string> {
  const existing = await resolveTarget(target)
  if (existing) return existing
  const t = target.replace(/\.md$/i, '').trim()
  // A folder-bearing target keeps its folder; a bare title lands in notes/.
  const relPath = t.includes('/') ? `${t}.md` : `notes/${t}.md`
  if (!isNotePath(relPath)) {
    throw new VaultPathError(`Not a valid note target: ${target}`)
  }
  const { app, indexer } = await getVault()
  const body = `# ${t}\n`
  await app.core.write(relPath, body, { author: 'human', baseHash: null })
  await indexer.reindexFile(relPath)
  return relPath
}

// ── Inline image serving (live-preview `![](…)` + `![[image]]` embeds) ────────
// The editor's live-preview renders local vault images via `/api/image?path=…`.
// Resolution + the path-traversal guard live HERE (server-only), funnelled
// through the core `Vault.resolveSafe` — the SAME symlink-aware guard the
// write-core uses — so the route can NEVER read a file outside the vault root.

const IMAGE_EXT_CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

export interface VaultImage {
  bytes: Buffer
  contentType: string
}

/** Cap a single served image at 25 MB so a huge embed can't buffer unbounded. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Read a vault-local image for the live-preview, guarded against path traversal.
 *
 * `rawPath` is a vault-relative path (`![](photos/cat.png)`) OR a bare basename
 * (`![[cat.png]]` embed). A bare basename is resolved against the vault's image
 * files by basename (Obsidian semantics). Every candidate is run through
 * `Vault.resolveSafe` (lexical `..`/absolute guard PLUS a symlink-aware realpath
 * check), so a `?path=../../etc/passwd` — or an in-vault symlink pointing out —
 * is rejected before any byte is read. Returns null on a miss / non-image /
 * rejected path; the route maps that to a 404 (never leaks why).
 */
export async function readVaultImage(rawPath: string): Promise<VaultImage | null> {
  const cleaned = rawPath.trim()
  if (cleaned === '') return null
  const ext = path.extname(cleaned).toLowerCase()
  const contentType = IMAGE_EXT_CONTENT_TYPE[ext]
  if (!contentType) return null // not a recognised image type → 404, never read

  const { app } = await getVault()
  // A bare basename (no slash) is an Obsidian embed target — resolve it to the
  // first matching image file in the vault by basename.
  const relPath = cleaned.includes('/') ? cleaned : await resolveImageBasename(cleaned)
  if (relPath === null) return null
  // Defense in depth on top of the extension allowlist: never serve from a
  // dotfolder (`.git/`, `.obsidian/`) even if it has an image extension.
  if (!isContentPath(relPath)) return null

  let abs: string
  try {
    // The core guard: rejects `..`, absolute inputs, and in-vault symlinks that
    // escape the root. Anything outside the vault throws → caller gets null.
    abs = await app.vault.resolveSafe(relPath)
  } catch {
    return null
  }
  const { readFile, stat } = await import('node:fs/promises')
  try {
    // Reject an oversized file before reading it into memory — a 25 MB cap keeps
    // a giant embed from buffering unbounded into the process (→ 404, never read).
    const info = await stat(abs)
    if (info.size > MAX_IMAGE_BYTES) return null
    const bytes = await readFile(abs)
    return { bytes, contentType }
  } catch {
    return null // missing/unreadable → 404
  }
}

/** Resolve a bare image basename (e.g. `cat.png`) to its vault-relative path. */
async function resolveImageBasename(basename: string): Promise<string | null> {
  const { app } = await getVault()
  const target = basename.toLowerCase()
  // Walk the vault for image files (listMarkdown only lists .md, so do our own
  // shallow-ish walk via the vault root, reusing the same dotfolder skipping).
  const { readdir } = await import('node:fs/promises')
  const found: string[] = []
  const walk = async (relDir: string): Promise<void> => {
    const absDir = relDir === '' ? app.vault.root : path.join(app.vault.root, relDir)
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(rel)
      } else if (
        entry.name.toLowerCase() === target &&
        IMAGE_EXT_CONTENT_TYPE[path.extname(entry.name).toLowerCase()]
      ) {
        found.push(rel)
      }
    }
  }
  await walk('')
  if (found.length === 0) return null
  return found.sort()[0]! // deterministic on ambiguity (matches link resolution)
}

// ── Agent loop data layer ────────────────────────────────────────────────────
// The propose→approve loop, wired over the same vault/core/indexer the editor
// uses. The maker is the core's getMaker() (the deterministic MockMaker, which
// files inbox captures mechanically). Every mutation here is git-reversible (the
// agent writes as `author:'agent'`), which is what `undoLastAgentChange` leans on.

/** Run the agent once: read inbox+tasks, persist proposals. Returns the count. */
export async function runAgent(): Promise<{ proposals: number }> {
  const { app, indexer } = await getVault()
  const maker = getMaker()
  const { proposals } = await runAgentOnce({ vault: app.vault, core: app.core, indexer, maker })
  return { proposals: proposals.length }
}

/**
 * Approve a pending proposal: apply its ops as the agent, reindex, clear it.
 * When apply stops early (`applied:false`) the stopping error's name/message
 * ride along so the UI can tell an EXPECTED propose-time-CAS conflict
 * (ConflictError — the vault changed under the proposal, nothing overwritten)
 * apart from a real failure. Error objects don't cross the server-action
 * boundary, hence the plain-string fields.
 */
export async function approvePending(
  id: string,
): Promise<{ applied: boolean; errorName?: string; errorMessage?: string }> {
  const { app, indexer } = await getVault()
  const result = await approveProposalCore({ vault: app.vault, core: app.core, indexer, maker: getMaker() }, id)
  if (result.applied) return { applied: true }
  return { applied: false, errorName: result.error?.name, errorMessage: result.error?.message }
}

/** Dismiss a pending proposal (drop it from pending — no vault mutation). */
export async function dismissPending(id: string): Promise<void> {
  const { app } = await getVault()
  await dismissProposalCore(app.vault, id)
}

export type UndoResult =
  | { ok: true; reverted: string }
  | { ok: false; reason: string }

/**
 * Undo the agent's most recent change by reverting its latest agent-authored
 * commit (a NEW inverse commit — history is never rewritten). If the vault's
 * most recent change isn't the agent's (a human edited after the agent, or the
 * agent never wrote), this is a no-op with a friendly reason — an undo must
 * never silently revert a human's own work.
 */
export async function undoLastAgentChange(): Promise<UndoResult> {
  const { app, indexer } = await getVault()
  const head = await app.git.headCommit()
  if (head === null) return { ok: false, reason: 'Nothing to undo yet.' }
  if (head.authorName !== 'agentkeep-agent') {
    return { ok: false, reason: 'The latest change is yours, not the agent’s — nothing to undo.' }
  }
  try {
    const reverted = await app.git.revertCommit(head.sha)
    await indexer.reindexAll()
    return { ok: true, reverted }
  } catch (err) {
    return { ok: false, reason: `Couldn’t undo cleanly: ${(err as Error).message}` }
  }
}

/** Capture raw text into the inbox as the human, then reindex that file. */
export async function captureToVault(text: string): Promise<{ path: string } | { error: string }> {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'Nothing to capture.' }
  const { app, indexer } = await getVault()
  const { path: relPath } = await captureToInbox(app.core, trimmed, {
    createdISO: new Date().toISOString(),
  })
  await indexer.reindexFile(relPath)
  return { path: relPath }
}

/** Pending proposals straight from app-state (what the proposal board shows). */
export async function getPendingProposals() {
  const { app } = await getVault()
  return loadPendingProposals(app.vault)
}

/**
 * A human "last run" signal for the rail: the timestamp of the agent's most
 * recent commit, or null if it has never written. Honest — there is no daemon;
 * this is the last time the agent actually did anything.
 */
export async function lastAgentRunISO(): Promise<string | null> {
  const { app } = await getVault()
  const c = await app.git.lastAgentCommit()
  if (c === null) return null
  // Resolve the commit's author date via git (CommitInfo carries no date).
  try {
    const { simpleGit } = await import('simple-git')
    const iso = (await simpleGit(app.vault.root).raw(['show', '-s', '--format=%aI', c.sha])).trim()
    return iso || null
  } catch {
    return null
  }
}
