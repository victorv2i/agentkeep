import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault, type Agentkeep } from './index.js'
import { deleteNote } from './delete.js'
import { VaultPathError } from './errors.js'

let dir: string
let ak: Agentkeep

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-delete-'))
  ak = await openVault(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('deleteNote (core delete path)', () => {
  it('removes an existing note from disk and commits the deletion as the agent', async () => {
    await ak.core.write('inbox/cap_x.md', '# capture\n', { author: 'human', baseHash: null })
    const res = await deleteNote(ak.core,'inbox/cap_x.md')
    expect(res.ok).toBe(true)

    // gone from disk
    expect(await ak.core.read('inbox/cap_x.md')).toBeNull()
    await expect(readFile(join(dir, 'inbox/cap_x.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // the deletion is its own commit, attributed to the agent (git-reversible)
    const last = await ak.git.lastCommit('inbox/cap_x.md')
    expect(last?.authorName).toBe('agentkeep-agent')
    expect(last?.message).toMatch(/delete inbox\/cap_x\.md/)
  })

  it('returns ok:false (not-found) for a missing path and does not throw', async () => {
    const res = await deleteNote(ak.core,'inbox/nope.md')
    expect(res.ok).toBe(false)
  })

  it('rejects a traversal path (..) before touching git', async () => {
    // place a file OUTSIDE the vault to prove it is untouched
    const outside = join(dir, '..', 'outside-target.md')
    await writeFile(outside, 'do not delete me\n', 'utf8')
    try {
      await expect(deleteNote(ak.core,'../outside-target.md')).rejects.toBeInstanceOf(VaultPathError)
      // the outside file is still there
      expect(await readFile(outside, 'utf8')).toContain('do not delete me')
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('rejects an absolute path', async () => {
    const outside = join(dir, '..', 'abs-target.md')
    await writeFile(outside, 'keep\n', 'utf8')
    try {
      await expect(deleteNote(ak.core,outside)).rejects.toBeInstanceOf(VaultPathError)
      expect(await readFile(outside, 'utf8')).toContain('keep')
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('rejects an in-vault symlink that points outside the vault', async () => {
    const outside = join(dir, '..', 'symlink-target.md')
    await writeFile(outside, 'keep via symlink\n', 'utf8')
    await mkdir(join(dir, 'inbox'), { recursive: true })
    await symlink(outside, join(dir, 'inbox', 'link.md'))
    try {
      await expect(deleteNote(ak.core,'inbox/link.md')).rejects.toBeInstanceOf(VaultPathError)
      expect(await readFile(outside, 'utf8')).toContain('keep via symlink')
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('refuses to delete when baseHash no longer matches the file (CAS, no clobber)', async () => {
    await ak.core.write('inbox/cap_y.md', '# v1\n', { author: 'human', baseHash: null })
    await expect(deleteNote(ak.core, 'inbox/cap_y.md', 'not-the-current-hash')).rejects.toMatchObject({
      name: 'ConflictError',
    })
    // the file is NOT removed — a delete proposed against an old version can't
    // clobber an edit made since.
    expect(await ak.core.read('inbox/cap_y.md')).not.toBeNull()
  })

  it('deletes when baseHash matches the current content', async () => {
    const { hash } = await ak.core.write('inbox/cap_z.md', '# v1\n', { author: 'human', baseHash: null })
    const res = await deleteNote(ak.core, 'inbox/cap_z.md', hash)
    expect(res.ok).toBe(true)
    expect(await ak.core.read('inbox/cap_z.md')).toBeNull()
  })
})
