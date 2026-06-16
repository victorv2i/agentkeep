import { describe, it, expect } from 'vitest'
import { newId } from './ids.js'

describe('newId (deterministic, no time/random)', () => {
  it('shapes the id as <prefix>_<8 hex>', () => {
    expect(newId('t', 'hello')).toMatch(/^t_[0-9a-f]{8}$/)
    expect(newId('cap', 'a longer seed string')).toMatch(/^cap_[0-9a-f]{8}$/)
  })

  it('is deterministic — same (prefix, seed) yields the same id', () => {
    expect(newId('t', 'same seed')).toBe(newId('t', 'same seed'))
  })

  it('differs when the seed differs', () => {
    expect(newId('cap', 'one')).not.toBe(newId('cap', 'two'))
  })

  it('differs when the prefix differs even for the same seed', () => {
    expect(newId('a', 's')).not.toBe(newId('b', 's'))
  })
})
