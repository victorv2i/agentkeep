import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { findDuplicateTitleLine, frontmatterRange, normalizeTitle } from './note-shape'

const state = (doc: string) => EditorState.create({ doc })

describe('frontmatterRange (the YAML block at the top of a note)', () => {
  it('finds a --- delimited block starting at line 1', () => {
    const s = state('---\ntitle: Coffee\nupdated: "2026-06-10"\n---\n\nBody.')
    const fm = frontmatterRange(s)!
    expect(fm.from).toBe(0)
    expect(s.doc.lineAt(fm.to).number).toBe(4)
  })

  it('accepts the YAML ... end marker as the closer', () => {
    const s = state('---\ntype: fact\n...\nBody.')
    expect(s.doc.lineAt(frontmatterRange(s)!.to).number).toBe(3)
  })

  it('ignores a --- that does not open the document', () => {
    expect(frontmatterRange(state('Body first.\n---\ntitle: nope\n---'))).toBeNull()
    expect(frontmatterRange(state('\n---\ntitle: nope\n---'))).toBeNull()
  })

  it('returns null when the block never closes (it is just a rule + text)', () => {
    expect(frontmatterRange(state('---\ntitle: dangling'))).toBeNull()
    expect(frontmatterRange(state('---'))).toBeNull()
  })
})

describe('normalizeTitle', () => {
  it('ignores case and collapses runs of whitespace', () => {
    expect(normalizeTitle('  Weekly   Review\tCadence ')).toBe('weekly review cadence')
  })
})

describe('findDuplicateTitleLine (the in-body H1 that repeats the header)', () => {
  it('matches a leading H1 equal to the title, case/whitespace-insensitive', () => {
    const s = state('# Weekly  Review\n\nBody.')
    const line = findDuplicateTitleLine(s, 'weekly review')!
    expect(s.doc.lineAt(line.from).number).toBe(1)
  })

  it('skips frontmatter and blank lines to reach the first content line', () => {
    const s = state('---\ntitle: Coffee preference\n---\n\n# Coffee preference\n\nBody.')
    const line = findDuplicateTitleLine(s, 'Coffee preference')!
    expect(s.doc.lineAt(line.from).number).toBe(5)
  })

  it('leaves an H1 with different text alone', () => {
    expect(findDuplicateTitleLine(state('# Something else\n\nBody.'), 'Coffee')).toBeNull()
  })

  it('leaves an H1 that is not the first content line alone (real content)', () => {
    expect(findDuplicateTitleLine(state('Intro line.\n\n# Coffee'), 'Coffee')).toBeNull()
  })

  it('only dims an H1, never a deeper heading or an empty title', () => {
    expect(findDuplicateTitleLine(state('## Coffee\n\nBody.'), 'Coffee')).toBeNull()
    expect(findDuplicateTitleLine(state('# Coffee\n\nBody.'), '')).toBeNull()
  })
})
