import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault, type Agentkeep } from './index.js'
import { Indexer } from './indexer.js'
import { readNote } from './frontmatter.js'
import { createVaultTools, type VaultTool } from './vault-tools.js'

/** Deterministic clock for the suite — `remember` stamps `updated` from this. */
const FIXED_NOW = new Date('2026-06-10T12:00:00Z')

let dir: string
let ak: Agentkeep
let indexer: Indexer
let tools: Record<string, VaultTool>

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools[name]
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.handler(args)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-tools-'))
  ak = await openVault(dir)
  // seed a couple of notes with a wikilink so search + backlinks have data
  await ak.core.write('notes/alpha.md', '# Alpha\n\nLinks to [[beta]] about widgets.\n', { author: 'human', baseHash: null })
  await ak.core.write('notes/beta.md', '# Beta\n\nThe widgets note.\n', { author: 'human', baseHash: null })
  indexer = new Indexer(ak.vault)
  await indexer.reindexAll()
  const list = createVaultTools({ vault: ak.vault, git: ak.git, core: ak.core, indexer, now: FIXED_NOW })
  tools = Object.fromEntries(list.map((t) => [t.name, t]))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('createVaultTools', () => {
  it('exposes exactly the nine seam tools with descriptions and schemas', () => {
    expect(Object.keys(tools).sort()).toEqual(
      ['capture', 'delete_note', 'get_backlinks', 'list_notes', 'list_tasks', 'read_note', 'remember', 'search', 'write_note'].sort(),
    )
    for (const t of Object.values(tools)) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.inputSchema).toBeTypeOf('object')
    }
  })

  it('search returns ranked hits for a query', async () => {
    const r = await call('search', { query: 'widgets' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const hits = r.data as Array<{ path: string; score: number }>
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const paths = hits.map((h) => h.path)
    expect(paths).toContain('notes/beta.md')
    // ranked: scores are descending
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
  })

  it('read_note round-trips content with the content hash', async () => {
    const r = await call('read_note', { path: 'notes/beta.md' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { content: string; hash: string }
    expect(data.content).toContain('The widgets note.')
    // the hash matches what WriteCore reports for the same file
    const direct = await ak.core.read('notes/beta.md')
    expect(data.hash).toBe(direct!.hash)
  })

  it('read_note returns a not-found result (ok:false) for a missing path', async () => {
    const r = await call('read_note', { path: 'notes/nope.md' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(404)
    expect(r.error).toMatch(/not found/i)
  })

  it('write_note creates and commits a note as the agent', async () => {
    const r = await call('write_note', { path: 'notes/gamma.md', content: '# Gamma\n\nFresh agent note.\n' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { hash: string; commit: string }
    expect(data.hash).toBeTruthy()
    expect(data.commit).toBeTruthy()

    const onDisk = await ak.core.read('notes/gamma.md')
    expect(onDisk!.content).toContain('Fresh agent note.')
    expect(onDisk!.hash).toBe(data.hash)

    // attributed to the agent identity, not the human
    const last = await ak.git.lastCommit('notes/gamma.md')
    expect(last?.authorName).toBe('agentkeep-agent')
  })

  it('write_note updates an existing note when given the current baseHash', async () => {
    const before = await ak.core.read('notes/beta.md')
    const r = await call('write_note', {
      path: 'notes/beta.md',
      content: '# Beta\n\nUpdated by the agent.\n',
      baseHash: before!.hash,
    })
    expect(r.ok).toBe(true)
    const after = await ak.core.read('notes/beta.md')
    expect(after!.content).toContain('Updated by the agent.')
  })

  it('write_note with a stale baseHash returns the 409 conflict shape (does not throw)', async () => {
    const r = await call('write_note', {
      path: 'notes/beta.md',
      content: '# Beta\n\nClobber attempt.\n',
      baseHash: 'deadbeef-not-the-real-hash',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(409)
    expect(r.error).toMatch(/conflict|hash|stale|changed/i)
    // the file is unchanged — the conflict protected the human's bytes
    const after = await ak.core.read('notes/beta.md')
    expect(after!.content).toContain('The widgets note.')
  })

  it('write_note with no baseHash on an existing path conflicts (expect-create)', async () => {
    const r = await call('write_note', { path: 'notes/beta.md', content: 'overwrite\n' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(409)
  })

  it('list_notes returns all markdown paths', async () => {
    const r = await call('list_notes', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const paths = r.data as string[]
    expect(paths).toContain('notes/alpha.md')
    expect(paths).toContain('notes/beta.md')
  })

  it('list_tasks returns tasks (empty array when none)', async () => {
    const empty = await call('list_tasks', {})
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.data).toEqual([])

    await ak.core.write(
      'tasks/t1.json',
      JSON.stringify({ id: 't1', title: 'do the thing', status: 'today', created: '2026-06-08T00:00:00Z' }, null, 2) + '\n',
      { author: 'human', baseHash: null },
    )
    const r = await call('list_tasks', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const list = r.data as Array<{ id: string; title: string }>
    expect(list.map((t) => t.id)).toContain('t1')
  })

  it('get_backlinks returns notes that link to the target', async () => {
    const r = await call('get_backlinks', { path: 'notes/beta.md' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const backlinks = r.data as string[]
    expect(backlinks).toContain('notes/alpha.md')
  })

  it('capture lands a timestamped inbox file and indexes it', async () => {
    const r = await call('capture', { text: 'remember to ship phase 5' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { path: string; id: string }
    expect(data.path).toMatch(/^inbox\/.+\.md$/)
    const onDisk = await ak.core.read(data.path)
    expect(onDisk!.content).toContain('remember to ship phase 5')
  })

  it('write_note attribution is independent of the human path', async () => {
    // a human-authored capture, then an agent write — distinct git identities
    await call('capture', { text: 'a human-style capture' })
    await call('write_note', { path: 'notes/delta.md', content: 'agent note\n' })
    const agentCommit = await ak.git.lastCommit('notes/delta.md')
    expect(agentCommit?.authorName).toBe('agentkeep-agent')
  })

  it('write_note keeps the live index fresh: search finds the new note immediately', async () => {
    const w = await call('write_note', {
      path: 'notes/fresh.md',
      content: '# Fresh\n\nA note about zorblefrobs.\n',
    })
    expect(w.ok).toBe(true)
    const r = await call('search', { query: 'zorblefrobs' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const paths = (r.data as Array<{ path: string }>).map((h) => h.path)
    expect(paths).toContain('notes/fresh.md')
  })

  it('capture keeps the live index fresh: search finds the captured inbox note immediately', async () => {
    const c = await call('capture', { text: 'a captured thought about quibblezorp' })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const path = (c.data as { path: string }).path
    const r = await call('search', { query: 'quibblezorp' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const paths = (r.data as Array<{ path: string }>).map((h) => h.path)
    expect(paths).toContain(path)
  })

  it('capture is idempotent through the tool handler for duplicate text', async () => {
    const first = await call('capture', { text: 'duplicate tool capture' })
    const second = await call('capture', { text: 'duplicate tool capture' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.data).toEqual(first.data)
    const path = (first.data as { path: string }).path
    const list = await call('list_notes', {})
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.data as string[]).filter((p) => p === path)).toHaveLength(1)
  })

  it('delete_note removes an existing note, commits as agent, and drops it from the index', async () => {
    // capture an inbox note (indexed), then delete it through the tool
    const c = await call('capture', { text: 'an inbox note about flibbergib to be filed then deleted' })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const path = (c.data as { path: string }).path
    // it is searchable before deletion
    const before = await call('search', { query: 'flibbergib' })
    expect(before.ok).toBe(true)
    if (before.ok) expect((before.data as Array<{ path: string }>).map((h) => h.path)).toContain(path)

    const r = await call('delete_note', { path })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.data as { ok: boolean; commit: string }).ok).toBe(true)
    expect((r.data as { commit: string }).commit).toBeTruthy()

    // gone from disk
    expect(await ak.core.read(path)).toBeNull()
    await expect(readFile(join(dir, path), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // the deletion is a commit attributed to the agent (git-reversible)
    const last = await ak.git.lastCommit(path)
    expect(last?.authorName).toBe('agentkeep-agent')
    // dropped from the live index: search no longer finds it
    const after = await call('search', { query: 'flibbergib' })
    expect(after.ok).toBe(true)
    if (after.ok) expect((after.data as Array<{ path: string }>).map((h) => h.path)).not.toContain(path)
  })

  it('remember creates memory/<slug>.md with parseable frontmatter and the right fields', async () => {
    const r = await call('remember', {
      topic: 'Coffee Preference',
      content: 'The user takes their coffee black, no sugar.',
      type: 'preference',
      source: 'session 2026-06-10',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { path: string; hash: string; commit: string }
    expect(data.path).toBe('memory/coffee-preference.md')
    expect(data.hash).toBeTruthy()
    expect(data.commit).toBeTruthy()

    const onDisk = await ak.core.read('memory/coffee-preference.md')
    const parsed = readNote(onDisk!.content)
    expect(parsed.data.title).toBe('Coffee Preference') // the human topic — the UI never shows the slug
    expect(parsed.data.type).toBe('preference')
    expect(parsed.data.source).toBe('session 2026-06-10')
    expect(parsed.data.updated).toBe('2026-06-10') // the injected clock's date, as a STRING
    expect(parsed.body).toContain('The user takes their coffee black, no sugar.')

    // committed as the agent
    const last = await ak.git.lastCommit('memory/coffee-preference.md')
    expect(last?.authorName).toBe('agentkeep-agent')
  })

  it('remember defaults type to fact and omits source when not given', async () => {
    const r = await call('remember', { topic: 'timezone', content: 'The user is in US Eastern time.' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const onDisk = await ak.core.read('memory/timezone.md')
    const parsed = readNote(onDisk!.content)
    expect(parsed.data.type).toBe('fact')
    expect('source' in parsed.data).toBe(false)
  })

  it('remember upserts: a second call on the same topic replaces the whole file', async () => {
    await call('remember', { topic: 'editor', content: 'Uses VS Code.', type: 'preference' })
    const r = await call('remember', { topic: 'editor', content: 'Switched to Zed.', type: 'preference', source: 'chat' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const onDisk = await ak.core.read('memory/editor.md')
    const parsed = readNote(onDisk!.content)
    expect(parsed.body).toContain('Switched to Zed.')
    expect(parsed.body).not.toContain('VS Code')
    expect(parsed.data.source).toBe('chat')
    expect(parsed.data.updated).toBe('2026-06-10')
    // both writes are agent-authored commits (the update is a fresh commit)
    const last = await ak.git.lastCommit('memory/editor.md')
    expect(last?.authorName).toBe('agentkeep-agent')
    // and the live index sees it
    const s = await call('search', { query: 'Zed' })
    expect(s.ok).toBe(true)
    if (s.ok) expect((s.data as Array<{ path: string }>).map((h) => h.path)).toContain('memory/editor.md')
  })

  it('remember folds a reworded near-duplicate topic into the existing note instead of forking', async () => {
    // First remember establishes + indexes the canonical note.
    await call('remember', { topic: 'LDI team meeting summary', content: 'The original summary.', source: 'cron' })
    // A reworded topic (one extra filler word) must UPDATE that file, not fork a
    // second memory/ldi-team-meeting-ultimate-summary.md. Title-token Jaccard 4/5 = 0.8.
    const r = await call('remember', {
      topic: 'LDI team meeting ultimate summary',
      content: 'The fuller summary that supersedes.',
      source: 'cron',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.data as { path: string; merged?: boolean }).path).toBe('memory/ldi-team-meeting-summary.md')
    expect((r.data as { merged?: boolean }).merged).toBe(true)
    // exactly ONE ldi-team-meeting note exists (no fork)
    const list = await call('list_notes', {})
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect((list.data as string[]).filter((p) => p.startsWith('memory/ldi-team-meeting'))).toEqual([
      'memory/ldi-team-meeting-summary.md',
    ])
    // and it holds the superseding content
    const onDisk = await ak.core.read('memory/ldi-team-meeting-summary.md')
    expect(onDisk!.content).toContain('supersedes')
    expect(onDisk!.content).not.toContain('The original summary')
  })

  it('remember keeps a merely-related topic as its own note (does not over-merge)', async () => {
    await call('remember', { topic: 'Agent Deck', content: 'The product.', type: 'project' })
    // {agent,deck} vs {agent,deck,status} Jaccard = 0.67 < 0.8 → stays a distinct note.
    const r = await call('remember', { topic: 'Agent Deck status', content: 'Shipped phase 3.', type: 'project' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.data as { path: string }).path).toBe('memory/agent-deck-status.md')
    expect(await ak.core.read('memory/agent-deck.md')).not.toBeNull()
    expect(await ak.core.read('memory/agent-deck-status.md')).not.toBeNull()
  })

  it('remember slugifies the topic (lowercase, non-alphanumerics collapse to single dashes)', async () => {
    const r = await call('remember', { topic: 'My  Topic!!', content: 'slug check' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.data as { path: string }).path).toBe('memory/my-topic.md')
  })

  it('remember rejects an empty topic and empty content (400 values, not throws)', async () => {
    const noTopic = await call('remember', { topic: '   ', content: 'something' })
    expect(noTopic.ok).toBe(false)
    if (!noTopic.ok) expect(noTopic.code).toBe(400)
    // a topic that slugifies to nothing is as empty as a blank one
    const junkTopic = await call('remember', { topic: '!!!', content: 'something' })
    expect(junkTopic.ok).toBe(false)
    if (!junkTopic.ok) expect(junkTopic.code).toBe(400)
    const noContent = await call('remember', { topic: 'real topic', content: '  ' })
    expect(noContent.ok).toBe(false)
    if (!noContent.ok) expect(noContent.code).toBe(400)
  })

  it('delete_note on a missing path returns the 404 result shape (does not throw)', async () => {
    const r = await call('delete_note', { path: 'inbox/never-existed.md' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe(404)
    expect(r.error).toMatch(/not found/i)
  })

  it('delete_note rejects a traversal path (400) without touching anything outside the vault', async () => {
    const outside = join(dir, '..', 'ak-tools-outside.md')
    await writeFile(outside, 'do not delete me\n', 'utf8')
    try {
      const r = await call('delete_note', { path: '../ak-tools-outside.md' })
      expect(r.ok).toBe(false) // a value, never a throw
      if (r.ok) return
      expect(r.code).toBe(400)
      // the file outside the vault is untouched
      expect(await readFile(outside, 'utf8')).toContain('do not delete me')
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('delete_note rejects an absolute path (400)', async () => {
    const outside = join(dir, '..', 'ak-tools-abs.md')
    await writeFile(outside, 'keep\n', 'utf8')
    try {
      const r = await call('delete_note', { path: outside })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe(400)
      expect(await readFile(outside, 'utf8')).toContain('keep')
    } finally {
      await rm(outside, { force: true })
    }
  })
})
