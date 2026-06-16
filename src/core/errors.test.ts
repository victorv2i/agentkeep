import { describe, it, expect } from 'vitest'
import { ConflictError, ValidationError, VaultPathError } from './errors.js'

describe('errors', () => {
  it('ConflictError carries expected + actual hash and a 409 code', () => {
    const e = new ConflictError('notes/a.md', 'expected', 'actual')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ConflictError')
    expect(e.httpStatus).toBe(409)
    expect(e.path).toBe('notes/a.md')
    expect(e.expectedHash).toBe('expected')
    expect(e.actualHash).toBe('actual')
  })
  it('ValidationError and VaultPathError set their names', () => {
    expect(new ValidationError('bad').name).toBe('ValidationError')
    expect(new VaultPathError('bad').name).toBe('VaultPathError')
  })
})
