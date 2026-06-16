import { describe, it, expect } from 'vitest'
import { parseNote } from './parse.js'

describe('parseNote', () => {
  it('extracts title, tags, link targets, and body from a kitchen-sink note', () => {
    const raw = [
      '---',
      'title: Invoice Note',
      'tags: [invoice]',
      '---',
      '# Heading One',
      '',
      'Body with [[A]], [[B|alias]], [[C#h]], ![[D]] and a #todo here.',
      '',
    ].join('\n')

    const meta = parseNote('notes/invoice.md', raw)

    expect(meta.path).toBe('notes/invoice.md')
    expect(meta.title).toBe('Invoice Note')
    // frontmatter tag ∪ inline #todo, deduped
    expect(meta.tags).toEqual(['invoice', 'todo'])
    // wikilink TARGETS only: alias/heading/embed-prefix stripped, order preserved, deduped
    expect(meta.links).toEqual(['A', 'B', 'C', 'D'])
    // body is the frontmatter-stripped text (used for search)
    expect(meta.text).toContain('Body with')
    expect(meta.text).not.toContain('title: Invoice Note')
  })

  it('falls back to the basename when there is no frontmatter title and no H1', () => {
    const raw = 'just some prose, no heading, no frontmatter.\n'
    const meta = parseNote('notes/My Cool Note.md', raw)
    expect(meta.title).toBe('My Cool Note')
    expect(meta.tags).toEqual([])
    expect(meta.links).toEqual([])
  })

  it('uses the first H1 as title when frontmatter has no title', () => {
    const raw = '# Real Title\n\nbody\n'
    expect(parseNote('a.md', raw).title).toBe('Real Title')
  })

  it('reads tags from a comma-separated frontmatter string and dedups with inline tags', () => {
    const raw = ['---', 'tags: invoice, urgent', '---', 'text #urgent #new'].join('\n')
    const meta = parseNote('a.md', raw)
    expect(meta.tags).toEqual(['invoice', 'urgent', 'new'])
  })

  it('strips ^block refs and resolves embeds to their bare target', () => {
    const raw = 'see ![[D#sec]] and [[F^block-id]] and [[notes/Deep Note|x]]'
    const meta = parseNote('a.md', raw)
    expect(meta.links).toEqual(['D', 'F', 'notes/Deep Note'])
  })

  it('dedups repeated link targets while preserving first-seen order', () => {
    const raw = '[[A]] [[B]] [[A]] [[A|other]]'
    expect(parseNote('a.md', raw).links).toEqual(['A', 'B'])
  })

  it('parses a pathological run of "[" in linear time (ReDoS guard)', () => {
    // A `[`-only note used to make WIKILINK_RE rescan to the end from every
    // `[[` start (O(n^2)) and stall the indexer. Excluding `[` from the target
    // class makes each start fail fast. Timed, since a sync hang can't be caught
    // by a vitest timeout: the quadratic regex blows past this budget, the fix
    // finishes in single-digit ms.
    const raw = '['.repeat(200_000)
    const start = Date.now()
    expect(parseNote('a.md', raw).links).toEqual([])
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
