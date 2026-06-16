import { describe, it, expect } from 'vitest'
import { contentHash } from './hash.js'

describe('contentHash', () => {
  it('is a 64-char hex sha256, stable for the same content', () => {
    const a = contentHash('# Hello\n')
    const b = contentHash('# Hello\n')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })
  it('differs when content differs', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'))
  })
})
