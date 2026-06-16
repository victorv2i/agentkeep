import { describe, it, expect, beforeEach } from 'vitest'
import { LinkGraph } from './link-graph.js'

let g: LinkGraph
beforeEach(() => { g = new LinkGraph() })

describe('LinkGraph (Obsidian basename resolution)', () => {
  it('resolves a basename link in both directions once both notes exist', () => {
    g.setNote('notes/A.md', ['B'])
    g.setNote('notes/B.md', [])
    expect(g.getLinks('notes/A.md')).toContain('notes/B.md')
    expect(g.getBacklinks('notes/B.md')).toContain('notes/A.md')
  })

  it('treats an unresolved target as a first-class placeholder that resolves later', () => {
    g.setNote('notes/A.md', ['Missing'])
    expect(g.getPlaceholders()).toContain('Missing')
    expect(g.getBacklinks('notes/Missing.md')).toEqual([])

    // adding the target note resolves the placeholder and surfaces the backlink
    g.setNote('notes/Missing.md', [])
    expect(g.getPlaceholders()).not.toContain('Missing')
    expect(g.getBacklinks('notes/Missing.md')).toContain('notes/A.md')
    expect(g.getLinks('notes/A.md')).toContain('notes/Missing.md')
  })

  it('clears edges in both directions when a note is removed (no stale edges)', () => {
    g.setNote('notes/A.md', ['B'])
    g.setNote('notes/B.md', [])
    expect(g.getBacklinks('notes/B.md')).toContain('notes/A.md')

    g.removeNote('notes/A.md')
    expect(g.getBacklinks('notes/B.md')).toEqual([])
    expect(g.getLinks('notes/A.md')).toEqual([])
  })

  it('reverts a resolved edge to a placeholder when the source note drops the link', () => {
    g.setNote('notes/A.md', ['B'])
    g.setNote('notes/B.md', [])
    g.setNote('notes/A.md', []) // A no longer links B
    expect(g.getBacklinks('notes/B.md')).toEqual([])
    expect(g.getPlaceholders()).not.toContain('B')
  })

  it('turns a resolved edge back into a placeholder when the target note is removed', () => {
    g.setNote('notes/A.md', ['B'])
    g.setNote('notes/B.md', [])
    expect(g.getBacklinks('notes/B.md')).toContain('notes/A.md')

    g.removeNote('notes/B.md')
    expect(g.getPlaceholders()).toContain('B') // A still points at the now-missing B
    expect(g.getLinks('notes/A.md')).toEqual([]) // no resolved target anymore
  })

  it('matches a full relative-path target (with or without .md)', () => {
    g.setNote('a.md', ['notes/Deep', 'notes/Other.md'])
    g.setNote('notes/Deep.md', [])
    g.setNote('notes/Other.md', [])
    expect(g.getLinks('a.md').sort()).toEqual(['notes/Deep.md', 'notes/Other.md'])
    expect(g.getBacklinks('notes/Deep.md')).toContain('a.md')
    expect(g.getBacklinks('notes/Other.md')).toContain('a.md')
  })

  it('returns a note’s unresolved raw targets via getUnresolved (deduped, resolution-live)', () => {
    g.setNote('notes/A.md', ['B', 'Missing', 'Missing', 'other/Gone'])
    g.setNote('notes/B.md', [])
    expect(g.getUnresolved('notes/A.md')).toEqual(['Missing', 'other/Gone'])
    expect(g.getUnresolved('notes/B.md')).toEqual([])
    expect(g.getUnresolved('notes/Nope.md')).toEqual([]) // unknown note → empty, no throw

    // creating the target resolves it out of the unresolved set
    g.setNote('notes/Missing.md', [])
    expect(g.getUnresolved('notes/A.md')).toEqual(['other/Gone'])
  })

  it('deduplicates backlinks when a source links the same target twice', () => {
    // parseNote dedups, but the graph must be robust to duplicate inputs too
    g.setNote('notes/A.md', ['B', 'B'])
    g.setNote('notes/B.md', [])
    expect(g.getBacklinks('notes/B.md')).toEqual(['notes/A.md'])
  })
})
