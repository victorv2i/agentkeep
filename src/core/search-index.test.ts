import { describe, it, expect, beforeEach } from 'vitest'
import { SearchIndex } from './search-index.js'
import type { NoteMeta } from './parse.js'

function note(path: string, title: string, text: string, tags: string[] = []): NoteMeta {
  return { path, title, tags, links: [], text }
}

let idx: SearchIndex
beforeEach(() => { idx = new SearchIndex() })

describe('SearchIndex (MiniSearch wrapper)', () => {
  it('finds notes by title and by body text, ranked', () => {
    idx.upsert(note('a.md', 'Invoice for Sam', 'pay the plumber'))
    idx.upsert(note('b.md', 'Grocery list', 'milk and invoice eggs'))
    idx.upsert(note('c.md', 'Holiday plans', 'flights to nowhere'))

    const byTitle = idx.search('invoice')
    const paths = byTitle.map((r) => r.path)
    expect(paths).toContain('a.md') // title hit
    expect(paths).toContain('b.md') // body hit
    expect(paths).not.toContain('c.md')
    // title boost: the title match ranks above the body-only match
    expect(byTitle[0]!.path).toBe('a.md')
    expect(byTitle[0]!.title).toBe('Invoice for Sam')
    expect(byTitle[0]!.score).toBeGreaterThan(0)

    expect(idx.search('plumber').map((r) => r.path)).toEqual(['a.md'])
  })

  it('matches on tags', () => {
    idx.upsert(note('a.md', 'Note A', 'body', ['urgent', 'finance']))
    expect(idx.search('finance').map((r) => r.path)).toEqual(['a.md'])
  })

  it('replaces a note on re-upsert (no duplicate results, new content searchable)', () => {
    idx.upsert(note('a.md', 'Original Title', 'apples'))
    idx.upsert(note('a.md', 'Updated Title', 'bananas'))

    expect(idx.search('apples')).toEqual([]) // old body gone
    const updated = idx.search('bananas')
    expect(updated.map((r) => r.path)).toEqual(['a.md']) // exactly one, no dupe
    expect(updated[0]!.title).toBe('Updated Title')
  })

  it('drops a note from results after remove', () => {
    idx.upsert(note('a.md', 'Deletable', 'ephemeral content'))
    expect(idx.search('ephemeral')).toHaveLength(1)
    idx.remove('a.md')
    expect(idx.search('ephemeral')).toEqual([])
  })

  it('remove is a no-op for an unknown path', () => {
    expect(() => idx.remove('ghost.md')).not.toThrow()
  })
})
