import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { Indexer } from './indexer.js'
import { VaultWatcher } from './watcher.js'
import { contentHash } from './hash.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'

let dir: string
let vault: Vault

async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

/** Poll a predicate up to `timeoutMs` instead of a brittle fixed sleep. */
async function eventually(fn: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) {
      expect.fail(`condition not met within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-watch-'))
  vault = new Vault(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('VaultWatcher.handleEvent (pure, no real FS timing)', () => {
  it('routes add/change to reindexFile and unlink to removeFile', async () => {
    await write('notes/A.md', '# A\n')
    const indexer = new Indexer(vault)
    const reindex = vi.spyOn(indexer, 'reindexFile')
    const remove = vi.spyOn(indexer, 'removeFile')
    const w = new VaultWatcher(vault, indexer)

    await w.handleEvent('add', 'notes/A.md')
    await w.handleEvent('change', 'notes/A.md')
    await w.handleEvent('unlink', 'notes/A.md')

    expect(reindex).toHaveBeenCalledTimes(2)
    expect(reindex).toHaveBeenCalledWith('notes/A.md')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('notes/A.md')
  })

  it('suppresses an add/change whose content hash is a self-write', async () => {
    const content = '# Self\n'
    await write('notes/S.md', content)
    const indexer = new Indexer(vault)
    const reindex = vi.spyOn(indexer, 'reindexFile')
    const w = new VaultWatcher(vault, indexer, {
      isSelfWrite: (path, hash) => path === 'notes/S.md' && hash === contentHash(content),
    })

    await w.handleEvent('change', 'notes/S.md')
    expect(reindex).not.toHaveBeenCalled() // suppressed: the write-core already indexed it
  })

  it('still indexes a change whose hash does NOT match a self-write', async () => {
    await write('notes/S.md', '# changed by a human\n')
    const indexer = new Indexer(vault)
    const reindex = vi.spyOn(indexer, 'reindexFile')
    const w = new VaultWatcher(vault, indexer, { isSelfWrite: () => false })

    await w.handleEvent('change', 'notes/S.md')
    expect(reindex).toHaveBeenCalledWith('notes/S.md')
  })

  it('unlink is never suppressed (the file is gone, nothing to hash)', async () => {
    const indexer = new Indexer(vault)
    const remove = vi.spyOn(indexer, 'removeFile')
    const w = new VaultWatcher(vault, indexer, { isSelfWrite: () => true })
    await w.handleEvent('unlink', 'notes/Gone.md')
    expect(remove).toHaveBeenCalledWith('notes/Gone.md')
  })

  it('removes a stale index entry when resolving/reading the path fails on add/change', async () => {
    // A previously-indexed path whose read now fails (e.g. replaced by an
    // escaping symlink, or a permissions/race error from resolveSafe) must not
    // leave its OLD index entry behind — that produces stale search/backlink
    // hits until a restart. Simulate the failure by stubbing vault.resolveSafe
    // to throw, independent of any real filesystem race.
    await write('notes/Stale.md', '# Stale\n\nfindable kumquat.\n')
    const indexer = new Indexer(vault)
    await indexer.reindexAll()
    expect(indexer.search('kumquat')).toHaveLength(1)

    const remove = vi.spyOn(indexer, 'removeFile')
    vi.spyOn(vault, 'resolveSafe').mockRejectedValueOnce(new Error('simulated resolveSafe failure'))
    const w = new VaultWatcher(vault, indexer)

    await w.handleEvent('change', 'notes/Stale.md')

    expect(remove).toHaveBeenCalledWith('notes/Stale.md')
    expect(indexer.search('kumquat')).toHaveLength(0)
  })

  it('consumes a stale self-write marker so external A->B->A edits still reindex', async () => {
    const git = new VaultGit(dir)
    await git.ensureRepo()
    const core = new WriteCore(vault, git)
    await core.write('notes/S.md', '# A\n', { author: 'agent', baseHash: null })

    const indexer = new Indexer(vault)
    const reindex = vi.spyOn(indexer, 'reindexFile')
    const w = new VaultWatcher(vault, indexer, {
      isSelfWrite: (path, hash) => core.isSelfWrite(path, hash),
    })

    await write('notes/S.md', '# B\n')
    await w.handleEvent('change', 'notes/S.md')
    expect(reindex).toHaveBeenCalledTimes(1)

    await write('notes/S.md', '# A\n')
    await w.handleEvent('change', 'notes/S.md')
    expect(reindex).toHaveBeenCalledTimes(2)
  })
})

describe('VaultWatcher integration (real chokidar, polled)', () => {
  it('indexes a file created after the watcher starts', async () => {
    const indexer = new Indexer(vault)
    await indexer.reindexAll()
    const w = new VaultWatcher(vault, indexer)
    await w.start()
    try {
      await write('notes/Live.md', '# Watermelon\n\nfresh on disk.\n')
      await eventually(() => indexer.search('watermelon').some((r) => r.path === 'notes/Live.md'))
    } finally {
      await w.stop()
    }
  })

  it('removes a note from the index when its file is unlinked', async () => {
    await write('notes/Doomed.md', '# Doomed\n\ntransient content kiwi.\n')
    const indexer = new Indexer(vault)
    await indexer.reindexAll()
    expect(indexer.search('kiwi')).toHaveLength(1)

    const w = new VaultWatcher(vault, indexer)
    await w.start()
    try {
      await unlink(join(dir, 'notes/Doomed.md'))
      await eventually(() => indexer.search('kiwi').length === 0)
    } finally {
      await w.stop()
    }
  })

  it('suppresses a self-write (no reindex when isSelfWrite reports true)', async () => {
    const indexer = new Indexer(vault)
    await indexer.reindexAll()
    const reindex = vi.spyOn(indexer, 'reindexFile')

    // Mark whatever content lands at notes/Self.md as a self-write.
    const selfContent = '# Self Written\n\nby the write-core dragonfruit.\n'
    const w = new VaultWatcher(vault, indexer, {
      isSelfWrite: (path, hash) => path === 'notes/Self.md' && hash === contentHash(selfContent),
    })
    await w.start()
    try {
      await write('notes/Self.md', selfContent)
      // give the watcher real time to (not) fire, then assert no reindex + not searchable
      await new Promise((r) => setTimeout(r, 800))
      expect(reindex).not.toHaveBeenCalled()
      expect(indexer.search('dragonfruit')).toEqual([])
    } finally {
      await w.stop()
    }
  })
})
