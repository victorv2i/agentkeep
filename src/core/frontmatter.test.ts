import { describe, it, expect } from 'vitest'
import { readNote, setFrontmatterKey } from './frontmatter.js'

const SAMPLE = `---
title: Sam — Q3 invoice # a human comment
tags: [invoice, q3]
status: open
---

# Sam — Q3 invoice

Body stays exactly the same, even the [[Launch Agentkeep v1]] link.
`

describe('readNote', () => {
  it('splits frontmatter data and body', () => {
    const n = readNote(SAMPLE)
    expect(n.data.title).toBe('Sam — Q3 invoice')
    expect(n.data.status).toBe('open')
    expect(n.body).toContain('[[Launch Agentkeep v1]]')
  })

  it('does not execute JS frontmatter (---js fence)', () => {
    const sentinel = { pwned: false }
    ;(globalThis as Record<string, unknown>).__frontmatterSentinel = sentinel
    const evil = `---js\nglobalThis.__frontmatterSentinel.pwned = true;\n({})\n---\n\nBody\n`
    expect(() => readNote(evil)).not.toThrow()
    expect(sentinel.pwned).toBe(false)
    delete (globalThis as Record<string, unknown>).__frontmatterSentinel
  })

  it('does not execute JS frontmatter (---javascript fence)', () => {
    const sentinel = { pwned: false }
    ;(globalThis as Record<string, unknown>).__frontmatterSentinel2 = sentinel
    const evil = `---javascript\nglobalThis.__frontmatterSentinel2.pwned = true;\n({})\n---\n\nBody\n`
    expect(() => readNote(evil)).not.toThrow()
    expect(sentinel.pwned).toBe(false)
    delete (globalThis as Record<string, unknown>).__frontmatterSentinel2
  })

  it('returns the body safely (not a crash) for a blocked JS frontmatter note', () => {
    const evil = `---js\n({foo: "bar"})\n---\n\nBody text\n`
    const n = readNote(evil)
    expect(n.body).toContain('Body text')
    expect(n.data).toEqual({})
  })

  it('still parses a normal YAML note after the engine lockdown', () => {
    const n = readNote(SAMPLE)
    expect(n.data.title).toBe('Sam — Q3 invoice')
    expect(n.data.tags).toEqual(['invoice', 'q3'])
  })
})

describe('setFrontmatterKey', () => {
  it('changes one key and preserves the comment, other keys, and the body byte-for-byte', () => {
    const out = setFrontmatterKey(SAMPLE, 'status', 'closed')
    expect(out).toContain('status: closed')
    expect(out).toContain('# a human comment')      // comment preserved
    expect(out).toContain('tags: [invoice, q3]')    // other key + flow style preserved
    // body after the closing --- is untouched
    expect(out.slice(out.indexOf('\n---\n') + 5)).toBe(SAMPLE.slice(SAMPLE.indexOf('\n---\n') + 5))
  })

  it('is a no-op round-trip when setting a key to its current value (golden)', () => {
    const out = setFrontmatterKey(SAMPLE, 'status', 'open')
    expect(out).toBe(SAMPLE)
  })

  it('creates a frontmatter block when none exists', () => {
    const out = setFrontmatterKey('# Just a body\n', 'id', 'n_1')
    expect(out.startsWith('---\nid: n_1\n---\n')).toBe(true)
    expect(out.endsWith('# Just a body\n')).toBe(true)
  })

  it('quotes a timestamp string so it round-trips as a string (not a Date) through readNote', () => {
    const out = setFrontmatterKey('body\n', 'created', '2026-06-08T09:00:00Z')
    expect(out).toContain('created: "2026-06-08T09:00:00Z"')
    // gray-matter/js-yaml (YAML 1.1) would coerce an unquoted timestamp to a Date
    expect(readNote(out).data.created).toBe('2026-06-08T09:00:00Z')
  })

  it('quotes a YAML-1.1 bool-like string so it stays a string', () => {
    const out = setFrontmatterKey('body\n', 'answer', 'no')
    expect(out).toContain('answer: "no"')
    expect(readNote(out).data.answer).toBe('no')
  })

  it('preserves CRLF line endings in the frontmatter block (bytes round-trip)', () => {
    const crlf = '---\r\ntitle: hi\r\nstatus: open\r\n---\r\n\r\n# Body\r\nline\r\n'
    // no-op set to the current value must be byte-identical
    expect(setFrontmatterKey(crlf, 'status', 'open')).toBe(crlf)
    // changing a value keeps CRLF endings throughout the block
    const changed = setFrontmatterKey(crlf, 'status', 'closed')
    expect(changed).toContain('status: closed\r\n')
    expect(changed).not.toContain('status: closed\n\r') // no stray bare LF in block
    expect(changed.startsWith('---\r\n')).toBe(true)
    // body after the closing fence is untouched
    const bodyIdx = crlf.indexOf('\r\n---\r\n') + '\r\n---\r\n'.length
    expect(changed.slice(changed.indexOf('\r\n---\r\n') + '\r\n---\r\n'.length)).toBe(crlf.slice(bodyIdx))
  })

  it('adds a key without dropping an existing one when the frontmatter is EOF-terminated', () => {
    // No trailing newline after the closing fence. gray-matter (the read side)
    // parses this as frontmatter, but the write-side detection was stricter, so
    // a set used to PREPEND a second block and bury `title` in the body.
    const raw = '---\ntitle: Foo\n---'
    expect(readNote(raw).data.title).toBe('Foo')
    const out = setFrontmatterKey(raw, 'type', 'fact')
    const after = readNote(out)
    expect(after.data.title).toBe('Foo') // survives, not buried by a second block
    expect(after.data.type).toBe('fact')
  })

  it('adds a key without dropping an existing one when the closing fence has trailing whitespace', () => {
    const raw = '---\ntitle: Foo\n--- \n\n# Body\n'
    const before = readNote(raw)
    const out = setFrontmatterKey(raw, 'type', 'fact')
    const after = readNote(out)
    expect(after.data.type).toBe('fact')
    for (const k of Object.keys(before.data)) {
      expect(after.data[k]).toEqual((before.data as Record<string, unknown>)[k])
    }
  })
})
