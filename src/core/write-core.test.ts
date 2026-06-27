import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { ConflictError, VaultPathError } from './errors.js'
import { contentHash } from './hash.js'

const execFileP = promisify(execFile)

let dir: string
let core: WriteCore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-core-'))
  const git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(new Vault(dir), git)
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

describe('WriteCore', () => {
  it('creates a new file and returns its hash + commit', async () => {
    const res = await core.write('notes/a.md', '# A\n', { author: 'human', baseHash: null })
    expect(res.hash).toBe(contentHash('# A\n'))
    expect(res.commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await readFile(join(dir, 'notes/a.md'), 'utf8')).toBe('# A\n')
  })

  it('reads back the content with its current hash', async () => {
    await core.write('notes/a.md', 'one\n', { author: 'human', baseHash: null })
    const r = await core.read('notes/a.md')
    expect(r).toEqual({ content: 'one\n', hash: contentHash('one\n') })
  })

  it('rejects a stale write with ConflictError (compare-and-swap)', async () => {
    const first = await core.write('notes/a.md', 'v1\n', { author: 'human', baseHash: null })
    // someone else (or the agent) changes it underneath
    await core.write('notes/a.md', 'v2\n', { author: 'agent', baseHash: first.hash })
    // a writer holding the OLD hash must be rejected
    await expect(
      core.write('notes/a.md', 'v3\n', { author: 'human', baseHash: first.hash }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(await readFile(join(dir, 'notes/a.md'), 'utf8')).toBe('v2\n')
  })

  it('serializes concurrent writes to the same file (no lost update, no corruption)', async () => {
    const seed = await core.write('n.md', '0', { author: 'human', baseHash: null })
    // 5 writers each read-modify-write, retrying on conflict — final value must be a clean integer
    let hash = seed.hash
    const bump = async () => {
      for (;;) {
        const cur = await core.read('n.md')
        try {
          const res = await core.write('n.md', String(Number(cur!.content) + 1), { author: 'agent', baseHash: cur!.hash })
          hash = res.hash
          return
        } catch (e) {
          if (e instanceof ConflictError) continue
          throw e
        }
      }
    }
    await Promise.all([bump(), bump(), bump(), bump(), bump()])
    expect((await core.read('n.md'))!.content).toBe('5')
  })

  it('marks a just-written hash so a watcher can suppress the self-write', async () => {
    const res = await core.write('s.md', 'x\n', { author: 'agent', baseHash: null })
    expect(core.isSelfWrite('s.md', res.hash)).toBe(true)
    expect(core.isSelfWrite('s.md', 'some-other-hash')).toBe(false)
  })

  it('commits many DISTINCT files written concurrently without a git index.lock race', async () => {
    const n = 10
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        core.write(`c${i}.md`, `file ${i}\n`, { author: 'agent', baseHash: null }),
      ),
    )
    // all writes returned a real commit SHA (no raw GitError thrown)
    expect(results).toHaveLength(n)
    for (const r of results) expect(r.commit).toMatch(/^[0-9a-f]{7,40}$/)
    // every file is on disk and committed (has a last commit)
    for (let i = 0; i < n; i++) {
      expect(await readFile(join(dir, `c${i}.md`), 'utf8')).toBe(`file ${i}\n`)
      const last = await new VaultGit(dir).lastCommit(`c${i}.md`)
      expect(last).not.toBeNull()
    }
  })

  it('serializes two ALIASES of the same physical file (same baseHash → one wins, one 409)', async () => {
    // `a/n.md` and `a//n.md` are different raw caller strings but resolve to the
    // SAME absolute file and both survive the content-path guard + resolveSafe.
    // With the lock keyed on the resolved abs they share one mutex, so two writes
    // carrying the SAME baseHash cannot both pass the CAS: exactly one commits and
    // the other sees the now-changed content and gets a ConflictError. (Keyed on
    // the raw string they took different locks and BOTH committed, a silent lost
    // update with no 409.)
    const seed = await core.write('a/n.md', 'base\n', { author: 'human', baseHash: null })
    const settled = await Promise.allSettled([
      core.write('a/n.md', 'A\n', { author: 'agent', baseHash: seed.hash }),
      core.write('a//n.md', 'B\n', { author: 'agent', baseHash: seed.hash }),
    ])
    const fulfilled = settled.filter((s) => s.status === 'fulfilled')
    const conflicts = settled.filter(
      (s) => s.status === 'rejected' && s.reason instanceof ConflictError,
    )
    expect(fulfilled).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    // the file holds exactly the winner's content (a clean single write, not a
    // torn/lost update), and reading it back matches the winner's returned hash.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ hash: string }>).value
    const after = await core.read('a/n.md')
    expect(after!.hash).toBe(winner.hash)
    expect(['A\n', 'B\n']).toContain(after!.content)
  })

  it('a failed git add restores previous bytes and leaves the self-write marker unset', async () => {
    // Force a REAL, deterministic git failure (no mock): a stale `.git/index.lock`
    // makes the `git add` inside commitChange throw, so commitChange throws before
    // write() reaches `selfWrites.set`. The attempted content must be rolled back
    // and must NOT be marked a self-write, else the watcher would wrongly suppress
    // the resulting external-looking event.
    const seed = await core.write('n.md', 'v1\n', { author: 'human', baseHash: null })
    expect(core.isSelfWrite('n.md', seed.hash)).toBe(true) // consume the successful seed marker
    await writeFile(join(dir, '.git', 'index.lock'), '')
    try {
      await expect(
        core.write('n.md', 'v2\n', { author: 'agent', baseHash: seed.hash }),
      ).rejects.toThrow()
    } finally {
      await rm(join(dir, '.git', 'index.lock'), { force: true })
    }
    expect(await readFile(join(dir, 'n.md'), 'utf8')).toBe('v1\n')
    expect(await gitStatusFor('n.md')).toBe('')
    expect(core.isSelfWrite('n.md', contentHash('v2\n'))).toBe(false)
  })

  it('a failed git commit restores previous bytes and clears staged state', async () => {
    const seed = await core.write('n.md', 'v1\n', { author: 'human', baseHash: null })
    expect(core.isSelfWrite('n.md', seed.hash)).toBe(true)
    const lock = await lockHeadRef()

    try {
      await expect(
        core.write('n.md', 'v2\n', { author: 'agent', baseHash: seed.hash }),
      ).rejects.toThrow()
    } finally {
      await rm(lock, { force: true })
    }

    expect(await readFile(join(dir, 'n.md'), 'utf8')).toBe('v1\n')
    expect(await gitStatusFor('n.md')).toBe('')
    expect(core.isSelfWrite('n.md', contentHash('v2\n'))).toBe(false)
  })

  it('a failed git commit removes a newly-created file and clears staged state', async () => {
    const lock = await lockHeadRef()

    try {
      await expect(
        core.write('new.md', 'new file\n', { author: 'agent', baseHash: null }),
      ).rejects.toThrow()
    } finally {
      await rm(lock, { force: true })
    }

    await expect(readFile(join(dir, 'new.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gitStatusFor('new.md')).toBe('')
    expect(core.isSelfWrite('new.md', contentHash('new file\n'))).toBe(false)
  })

  it('refuses to read OR write through an in-vault symlink that escapes the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ak-outside-'))
    try {
      const secret = join(outside, 'secret.md')
      await writeFile(secret, 'original\n')
      // a symlink inside the vault pointing at the outside directory
      await symlink(outside, join(dir, 'link'))

      // read through the link is blocked
      await expect(core.read('link/secret.md')).rejects.toThrow(VaultPathError)
      // write through the link is blocked
      await expect(
        core.write('link/secret.md', 'pwned\n', { author: 'agent', baseHash: null }),
      ).rejects.toThrow(VaultPathError)
      // a brand-new file under the escaping link is also blocked
      await expect(
        core.write('link/new.md', 'pwned\n', { author: 'agent', baseHash: null }),
      ).rejects.toThrow(VaultPathError)

      // the outside file was never modified and no new file was created
      expect(await readFile(secret, 'utf8')).toBe('original\n')
      await expect(readFile(join(outside, 'new.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects backslash and root-level leading-dash content paths', async () => {
    await expect(
      core.write('--all.md', 'nope\n', { author: 'agent', baseHash: null }),
    ).rejects.toBeInstanceOf(VaultPathError)
    await expect(
      core.write('notes\\slash.md', 'nope\n', { author: 'agent', baseHash: null }),
    ).rejects.toBeInstanceOf(VaultPathError)
  })
})
