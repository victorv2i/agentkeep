import { describe, expect, it } from 'vitest'

import { displayTitle, isCaptureBasename } from './display-title.js'

describe('displayTitle', () => {
  it('frontmatter title wins over H1 and filename', () => {
    const raw = '---\ntitle: Launch plan\n---\n\n# Something else\n'
    expect(displayTitle('notes/daily-loop-2026-06-10.md', raw)).toBe('Launch plan')
  })

  it('frontmatter title wins for capture files too (never the hex)', () => {
    const raw = "---\ntitle: Sam's note\ntype: capture\n---\n\nbody\n"
    expect(displayTitle('inbox/cap_1212eebd.md', raw)).toBe("Sam's note")
  })

  it('first H1 wins when there is no frontmatter title', () => {
    const raw = '---\ntype: note\n---\n\n# Q3 invoice\n\nbody\n'
    expect(displayTitle('notes/q3-invoice.md', raw)).toBe('Q3 invoice')
  })

  it('humanizes a plain slug filename to sentence case', () => {
    expect(displayTitle('notes/cancelled.md', 'no heading here\n')).toBe('Cancelled')
    expect(displayTitle('notes/meeting_notes.md')).toBe('Meeting notes')
  })

  it('keeps a trailing date readable, set off with a comma', () => {
    expect(displayTitle('notes/daily-loop-2026-06-10.md')).toBe('Daily loop, 2026-06-10')
  })

  it('keeps a leading or lone date intact', () => {
    expect(displayTitle('brief/2026-06-10.md')).toBe('2026-06-10')
    expect(displayTitle('notes/2026-06-10-standup.md')).toBe('2026-06-10 standup')
  })

  it('never downcases the rest of the name (acronyms survive)', () => {
    expect(displayTitle('notes/API-design.md')).toBe('API design')
  })

  it('titles a capture from frontmatter created, never the hex id', () => {
    const raw = '---\nid: cap_1212eebd\ncreated: "2026-06-10T01:30:00.000Z"\ntype: capture\n---\n\nquick thought\n'
    const title = displayTitle('inbox/cap_1212eebd.md', raw)
    expect(title).toBe('Capture, 2026-06-10')
    expect(title).not.toContain('1212eebd')
  })

  it('accepts a YAML-coerced Date for created (unquoted Obsidian frontmatter)', () => {
    const raw = '---\ncreated: 2026-06-10T01:30:00.000Z\ntype: capture\n---\n\nquick thought\n'
    expect(displayTitle('inbox/cap_1212eebd.md', raw)).toBe('Capture, 2026-06-10')
  })

  it('falls back to file mtime when a capture has no created date', () => {
    const mtime = new Date('2026-06-11T22:15:00.000Z')
    expect(displayTitle('inbox/cap_deadbeef.md', 'just text\n', { mtime })).toBe(
      'Capture, 2026-06-11',
    )
  })

  it('degrades to a bare Capture when no date is known at all', () => {
    expect(displayTitle('inbox/cap_deadbeef.md')).toBe('Capture')
  })

  it('is deterministic for the same input', () => {
    const a = displayTitle('notes/daily-loop-2026-06-10.md')
    const b = displayTitle('notes/daily-loop-2026-06-10.md')
    expect(a).toBe(b)
  })
})

describe('isCaptureBasename', () => {
  it('matches content-derived capture ids only', () => {
    expect(isCaptureBasename('cap_1212eebd')).toBe(true)
    expect(isCaptureBasename('cap_DEADBEEF')).toBe(true)
    expect(isCaptureBasename('capture-notes')).toBe(false)
    expect(isCaptureBasename('cap_not-hex')).toBe(false)
    expect(isCaptureBasename('recap_12ab34cd')).toBe(false)
  })
})
