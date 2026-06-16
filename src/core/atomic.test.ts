import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, readFileOrNull } from './atomic.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-atomic-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('atomicWrite', () => {
  it('writes content that reads back exactly, creating parent dirs', async () => {
    const p = join(dir, 'sub', 'note.md')
    await atomicWrite(p, '# Hi\nbody\n')
    expect(await readFile(p, 'utf8')).toBe('# Hi\nbody\n')
  })
  it('leaves no temp files behind', async () => {
    const p = join(dir, 'note.md')
    await atomicWrite(p, 'x')
    expect(await readdir(dir)).toEqual(['note.md'])
  })
})

describe('readFileOrNull', () => {
  it('returns null for a missing file', async () => {
    expect(await readFileOrNull(join(dir, 'nope.md'))).toBeNull()
  })
})
