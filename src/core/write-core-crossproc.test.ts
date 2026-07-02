import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { ConflictError } from './errors.js'

// Two SEPARATE WriteCore/VaultGit instances pointed at the same vault dir —
// this is what the web app and the MCP server each do in their own process
// (they open independent handles). The in-memory per-instance mutex in
// write-core.ts and the repo-wide mutex in git.ts do NOT cover this: each
// instance's mutex only excludes writers within its OWN instance, so without a
// cross-process lock two "processes" can both pass the CAS check on the same
// baseHash and both write, losing one or corrupting git state.
let dir: string
let coreA: WriteCore
let coreB: WriteCore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-xproc-'))
  const gitA = new VaultGit(dir)
  await gitA.ensureRepo()
  coreA = new WriteCore(new Vault(dir), gitA)
  const gitB = new VaultGit(dir)
  coreB = new WriteCore(new Vault(dir), gitB)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('WriteCore cross-process serialization', () => {
  it('two independent instances racing a create on the SAME path: exactly one wins, the other gets a conflict', async () => {
    const results = await Promise.allSettled([
      coreA.write('notes/race.md', 'from A\n', { author: 'human', baseHash: null }),
      coreB.write('notes/race.md', 'from B\n', { author: 'agent', baseHash: null }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)

    // The on-disk + git state agrees with whichever write actually won —
    // never a torn/mixed result.
    const onDisk = await coreA.read('notes/race.md')
    expect(onDisk).not.toBeNull()
    expect(['from A\n', 'from B\n']).toContain(onDisk!.content)
  })

  it('two independent instances racing an UPDATE with the same stale baseHash: exactly one wins, the other 409s', async () => {
    const seed = await coreA.write('notes/upd.md', 'v1\n', { author: 'human', baseHash: null })

    const results = await Promise.allSettled([
      coreA.write('notes/upd.md', 'v2-from-A\n', { author: 'human', baseHash: seed.hash }),
      coreB.write('notes/upd.md', 'v2-from-B\n', { author: 'agent', baseHash: seed.hash }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)
  })
})
