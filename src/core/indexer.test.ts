import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { Indexer } from './indexer.js'

let dir: string
let indexer: Indexer

async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-indexer-'))
  await write('notes/A.md', '# Apple\n\nlinks to [[B]] and [[C]].\n')
  await write('notes/B.md', '# Banana\n\nlinks back to [[A]].\n')
  await write('notes/C.md', '# Cherry\n\nno links here, just fruit.\n')
  indexer = new Indexer(new Vault(dir))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('Indexer (rebuildable from files)', () => {
  it('reindexAll builds search + backlinks for the whole vault', async () => {
    await indexer.reindexAll()

    // search by body
    expect(indexer.search('banana').map((r) => r.path)).toContain('notes/B.md')
    // backlinks via Obsidian basename resolution
    expect(indexer.getBacklinks('notes/A.md')).toContain('notes/B.md')
    expect(indexer.getBacklinks('notes/B.md')).toContain('notes/A.md')
    expect(indexer.getBacklinks('notes/C.md')).toContain('notes/A.md')
    expect(indexer.getLinks('notes/A.md').sort()).toEqual(['notes/B.md', 'notes/C.md'])
  })

  it('reindexAll is a full rebuild — no stale state from a prior run', async () => {
    await indexer.reindexAll()
    // change A on disk to drop the link to C, then rebuild from files
    await write('notes/A.md', '# Apple\n\nonly [[B]] now.\n')
    await indexer.reindexAll()
    expect(indexer.getBacklinks('notes/C.md')).toEqual([])
    expect(indexer.getLinks('notes/A.md')).toEqual(['notes/B.md'])
  })

  it('reindexFile updates a single note in both search and graph', async () => {
    await indexer.reindexAll()
    expect(indexer.getBacklinks('notes/C.md')).toContain('notes/A.md')

    // A no longer links C
    await write('notes/A.md', '# Apricot\n\njust [[B]].\n')
    await indexer.reindexFile('notes/A.md')

    expect(indexer.getBacklinks('notes/C.md')).toEqual([]) // edge gone
    expect(indexer.getBacklinks('notes/B.md')).toContain('notes/A.md') // edge kept
    expect(indexer.search('apricot').map((r) => r.path)).toContain('notes/A.md') // new title
    expect(indexer.search('apple')).toEqual([]) // old title gone
  })

  it('reindexFile treats a deleted-on-disk file as a removal', async () => {
    await indexer.reindexAll()
    await unlink(join(dir, 'notes/C.md'))
    await indexer.reindexFile('notes/C.md')
    expect(indexer.search('cherry')).toEqual([])
    // C is now a placeholder again (A still links it), so no resolved backlink
    expect(indexer.getLinks('notes/A.md')).toEqual(['notes/B.md'])
  })

  it('removeFile drops a note from search and the graph', async () => {
    await indexer.reindexAll()
    indexer.removeFile('notes/B.md')
    expect(indexer.search('banana')).toEqual([])
    expect(indexer.getBacklinks('notes/A.md')).toEqual([]) // B was A's only backlink
  })

  it('reindexAll skips a file with malformed YAML frontmatter and indexes the rest', async () => {
    // A fresh vault: two valid notes around one with unterminated-quote YAML
    // (gray-matter throws YAMLException) — common in real Obsidian vaults.
    const bad = await mkdtemp(join(tmpdir(), 'ak-indexer-bad-'))
    try {
      const idx = new Indexer(new Vault(bad))
      await mkdir(join(bad, 'notes'), { recursive: true })
      await writeFile(join(bad, 'notes/Good1.md'), '# Good One\n\nfirst good note.\n', 'utf8')
      await writeFile(join(bad, 'notes/Bad.md'), '---\ntitle: "unterminated\n---\n# Bad\n', 'utf8')
      await writeFile(join(bad, 'notes/Good2.md'), '# Good Two\n\nlinks to [[Good1]].\n', 'utf8')

      // One bad file must NOT abort the whole reindex.
      await expect(idx.reindexAll()).resolves.not.toThrow()

      // Both good notes remain searchable and the Good2 -> Good1 backlink exists.
      expect(idx.search('first').map((r) => r.path)).toContain('notes/Good1.md')
      expect(idx.search('links').map((r) => r.path)).toContain('notes/Good2.md')
      expect(idx.getBacklinks('notes/Good1.md')).toContain('notes/Good2.md')
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  it('reindexFile does not throw on a single malformed-YAML file', async () => {
    await indexer.reindexAll()
    await write('notes/Bad.md', '---\ntitle: "unterminated\n---\n# Bad\n')
    await expect(indexer.reindexFile('notes/Bad.md')).resolves.not.toThrow()
  })

  it('reindexFile removes stale old entries when an indexed file becomes malformed', async () => {
    await indexer.reindexAll()
    expect(indexer.search('apple').map((r) => r.path)).toContain('notes/A.md')
    expect(indexer.getLinks('notes/A.md')).toContain('notes/B.md')

    await write('notes/A.md', '---\ntitle: "unterminated\n---\n# Broken\n')
    await expect(indexer.reindexFile('notes/A.md')).resolves.not.toThrow()

    expect(indexer.search('apple').map((r) => r.path)).not.toContain('notes/A.md')
    expect(indexer.getLinks('notes/A.md')).toEqual([])
    expect(indexer.notePaths()).not.toContain('notes/A.md')
  })
})
