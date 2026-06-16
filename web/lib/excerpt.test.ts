import { describe, it, expect } from 'vitest'
import { excerptOf } from './excerpt'

// The Memory page excerpt must read as prose, not raw markdown. The old version
// only stripped a leading heading mark, so list bullets and emphasis leaked
// ("- Alex shipped the Q3 release. *(2026-04-28)*").

describe('excerptOf', () => {
  it('strips a leading list bullet and inline emphasis (the real bug)', () => {
    expect(
      excerptOf('- Alex shipped the Q3 release. *(2026-04-28)*'),
    ).toBe('Alex shipped the Q3 release. (2026-04-28)')
  })

  it('strips headings, blockquotes, numbered and task markers', () => {
    expect(excerptOf('# Heading')).toBe('Heading')
    expect(excerptOf('> a quote')).toBe('a quote')
    expect(excerptOf('1. first item')).toBe('first item')
    expect(excerptOf('- [ ] do the thing')).toBe('do the thing')
  })

  it('unwraps inline code and links to their text', () => {
    expect(excerptOf('run `agentkeep-mcp` first')).toBe('run agentkeep-mcp first')
    expect(excerptOf('see [the doc](https://example.com) now')).toBe('see the doc now')
  })

  it('unwraps [[wikilinks]] to their display text (not raw markup)', () => {
    expect(excerptOf('See [[Agentkeep]] for the plan')).toBe('See Agentkeep for the plan')
    expect(excerptOf('Loop in [[notes/Deep Note|Mira]] today')).toBe('Loop in Mira today')
    expect(excerptOf('embeds ![[Spec]] and [[A#section]]')).toBe('embeds Spec and A')
  })

  it('uses the first non-empty, non-structural line', () => {
    expect(excerptOf('\n\n---\n\nReal content here')).toBe('Real content here')
  })

  it('caps at ~120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = excerptOf(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(120)
  })

  it('returns empty string for an empty body', () => {
    expect(excerptOf('')).toBe('')
    expect(excerptOf('\n\n')).toBe('')
  })
})
