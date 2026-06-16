import { describe, it, expect } from 'vitest'
import { makeSnippet, capHits, RESULT_CAP } from './snippet'

describe('makeSnippet (search result context windows)', () => {
  it('returns the context around the first match, split at the matched term', () => {
    const s = makeSnippet('pay the plumber before friday or the invoice doubles', 'plumber')!
    expect(s.match).toBe('plumber')
    expect(s.before).toBe('pay the ')
    expect(s.after).toBe(' before friday or the invoice doubles')
  })

  it('matches case-insensitively and extends a prefix match to the whole word', () => {
    const s = makeSnippet('Talk to the Plumbers union tomorrow', 'plumb')!
    expect(s.match).toBe('Plumbers') // original casing, full word
    expect(s.before).toBe('Talk to the ')
  })

  it('uses the EARLIEST occurrence across multiple query terms', () => {
    const s = makeSnippet('eggs first, then invoice Sam', 'invoice eggs')!
    expect(s.match).toBe('eggs')
  })

  it('truncates long bodies with ellipses on the cut sides only', () => {
    const pad = 'x'.repeat(200)
    const s = makeSnippet(`${pad} needle ${pad}`, 'needle')!
    expect(s.match).toBe('needle')
    expect(s.before.startsWith('…')).toBe(true)
    expect(s.after.endsWith('…')).toBe(true)
    expect(s.before.length).toBeLessThan(70)
    expect(s.after.length).toBeLessThan(110)
  })

  it('strips line-leading heading marks so a snippet never reads "# Title"', () => {
    const s = makeSnippet('# Morning Brief\n\nthe agent writes it each morning', 'morning')!
    expect(s.before).toBe('')
    expect(s.match).toBe('Morning')
    expect(s.after).toBe(' Brief the agent writes it each morning')
  })

  it('collapses newlines so the snippet reads as one line', () => {
    const s = makeSnippet('alpha\n\nbeta needle\ngamma', 'needle')!
    expect(s.before).toBe('alpha beta ')
    expect(s.after).toBe(' gamma')
  })

  it('falls back to the lead of the body with no emphasis when no term appears literally', () => {
    const s = makeSnippet('short note about something else entirely', 'plumbr')!
    expect(s.match).toBe('') // fuzzy/title hit — never a fake highlight
    expect(s.before).toBe('short note about something else entirely')
    expect(s.after).toBe('')
  })

  it('returns null for an empty body (client renders nothing, not a blank line)', () => {
    expect(makeSnippet('', 'anything')).toBeNull()
    expect(makeSnippet('   \n ', 'anything')).toBeNull()
  })
})

describe('capHits (server-side result cap + honest total)', () => {
  it('passes small lists through untouched with the true total', () => {
    const { top, total } = capHits([1, 2, 3])
    expect(top).toEqual([1, 2, 3])
    expect(total).toBe(3)
  })

  it(`caps at ${RESULT_CAP} but reports the pre-cap total`, () => {
    const hits = Array.from({ length: 95 }, (_, i) => i)
    const { top, total } = capHits(hits)
    expect(top).toHaveLength(RESULT_CAP)
    expect(top[0]).toBe(0) // highest-ranked first, cap keeps the head
    expect(total).toBe(95)
  })
})
