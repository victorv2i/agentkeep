import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { openVault, type Agentkeep } from './index.js'
import { deleteNote } from './delete.js'
import { VaultPathError } from './errors.js'

const execFileP = promisify(execFile)

let dir: string
let ak: Agentkeep

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-delete-'))
  ak = await openVault(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function gitStatusFor(relPath: string): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', dir, 'status', '--porcelain', '--', relPath])
  return String(stdout)
}

async function lockHeadRef(): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', dir, 'symbolic-ref', '--quiet', 'HEAD'])
  const ref = String(stdout).trim()
  const lock = join(dir, '.git', ...ref.split('/')) + '.lock'
  await mkdir(dirname(lock), { recursive: true })
  await writeFile(lock, 'stale lock\n', 'utf8')
  return lock
}

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

  it('a commit failure mid-delete does not leave the working file gone-from-disk', async () => {
    // `git rm` unlinks + stages the removal BEFORE the commit. A stale branch
    // ref lock makes only the commit throw; delete must restore the disk bytes
    // and unstage the deletion.
    const content = '# keep me\n'
    await ak.core.write('inbox/cap_fail.md', content, { author: 'human', baseHash: null })
    const lock = await lockHeadRef()

    try {
      await expect(deleteNote(ak.core, 'inbox/cap_fail.md')).rejects.toThrow()
    } finally {
      await rm(lock, { force: true })
    }

    expect(await readFile(join(dir, 'inbox/cap_fail.md'), 'utf8')).toBe(content)
    expect(await ak.core.read('inbox/cap_fail.md')).not.toBeNull()
    expect(await gitStatusFor('inbox/cap_fail.md')).toBe('')
  })
})
