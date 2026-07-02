import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withVaultLock } from './vault-lock.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-lock-'))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('withVaultLock', () => {
  it('runs the callback and releases the lock (a second call after it completes succeeds)', async () => {
    const first = await withVaultLock(dir, async () => 'a')
    const second = await withVaultLock(dir, async () => 'b')
    expect(first).toBe('a')
    expect(second).toBe('b')
  })

  it('serializes two overlapping callers on the SAME root so their bodies never interleave', async () => {
    const events: string[] = []
    const marker = join(dir, 'marker.txt')
    await writeFile(marker, '0')

    const slow = withVaultLock(dir, async () => {
      events.push('slow-start')
      const v = await readFile(marker, 'utf8')
      await new Promise((r) => setTimeout(r, 50))
      await writeFile(marker, String(Number(v) + 1))
      events.push('slow-end')
    })
    // Give `slow` a moment to acquire the lock first.
    await new Promise((r) => setTimeout(r, 10))
    const fast = withVaultLock(dir, async () => {
      events.push('fast-start')
      const v = await readFile(marker, 'utf8')
      await writeFile(marker, String(Number(v) + 1))
      events.push('fast-end')
    })

    await Promise.all([slow, fast])
    // If the two critical sections had interleaved, fast-start would appear
    // before slow-end.
    expect(events.indexOf('fast-start')).toBeGreaterThan(events.indexOf('slow-end'))
    expect(await readFile(marker, 'utf8')).toBe('2')
  })

  it('releases the lock even when the callback throws', async () => {
    await expect(
      withVaultLock(dir, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // The lock must not be stuck held — a follow-up call should succeed promptly.
    const result = await withVaultLock(dir, async () => 'ok')
    expect(result).toBe('ok')
  })
})
