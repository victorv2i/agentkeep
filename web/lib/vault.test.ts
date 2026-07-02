import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A note with malformed (unterminated-quote) YAML frontmatter must not crash
// the note list / load paths — it should degrade gracefully (list falls back
// to basename, load returns raw content + empty metadata) instead of 500-ing
// the whole page. `AGENTKEEP_VAULT` must be set BEFORE the first `getVault()`
// call (the handle is memoized on globalThis for the process lifetime), so
// this file sets it at module load, ahead of importing ./vault.

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-web-vault-'))
  await writeFile(join(dir, 'bad.md'), '---\ntitle: "oops\n---\n\nBody text\n')
  await writeFile(join(dir, 'good.md'), '---\ntitle: Good Note\n---\n\n# Good Note\n')
  process.env.AGENTKEEP_VAULT = dir
})

afterAll(async () => {
  delete process.env.AGENTKEEP_VAULT
  await rm(dir, { recursive: true, force: true })
})

describe('listNotes with malformed frontmatter', () => {
  it('does not throw and falls back the bad note to its basename title', async () => {
    const { listNotes } = await import('./vault')
    const items = await listNotes()
    const bad = items.find((n) => n.path === 'bad.md')
    const good = items.find((n) => n.path === 'good.md')
    expect(bad).toBeDefined()
    expect(bad!.title).toBe('Bad')
    expect(good).toBeDefined()
    expect(good!.title).toBe('Good Note')
  })
})

describe('loadNote with malformed frontmatter', () => {
  it('does not throw and returns raw content with empty metadata', async () => {
    const { loadNote } = await import('./vault')
    const note = await loadNote('bad.md')
    expect(note).not.toBeNull()
    expect(note!.content).toContain('Body text')
    expect(note!.title).toBe('Bad')
  })
})
