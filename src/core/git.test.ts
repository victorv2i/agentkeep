import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { VaultGit } from './git.js'
import { GitStateError } from './errors.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-git-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('VaultGit', () => {
  it('ensures a repo and commits a change with an author identity', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), '# A\n')
    const sha = await g.commitChange('note.md', { author: 'agent', message: 'file note' })
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    const last = await g.lastCommit('note.md')
    expect(last?.message).toContain('file note')
    expect(last?.authorName).toBe('agentkeep-agent')
  })

  it('records human vs agent authorship distinctly', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'h.md'), 'human\n')
    await g.commitChange('h.md', { author: 'human', message: 'human edit' })
    const last = await g.lastCommit('h.md')
    expect(last?.authorName).toBe('agentkeep-human')
  })

  it('treats leading-dash paths as pathspecs, not git options', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, '--all'), 'literal dash path\n')

    const sha = await g.commitChange('--all', { author: 'agent', message: 'agent: dash path' })
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(await readFile(join(dir, '--all'), 'utf8')).toBe('literal dash path\n')

    const last = await g.lastCommit('--all')
    expect(last?.message).toBe('agent: dash path')
    expect(last?.authorName).toBe('agentkeep-agent')

    const del = await g.removePath('--all', { author: 'agent', message: 'agent: delete dash path' })
    expect(del).toMatch(/^[0-9a-f]{7,40}$/)
    await expect(readFile(join(dir, '--all'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await g.noteHistory('--all')).map((h) => h.message)).toEqual([
      'agent: delete dash path',
      'agent: dash path',
    ])
  })

  it('lastAgentCommit finds the latest agent commit, skipping later human ones', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'a.md'), 'agent\n')
    const agentSha = await g.commitChange('a.md', { author: 'agent', message: 'agent: file' })
    await writeFile(join(dir, 'h.md'), 'human\n')
    await g.commitChange('h.md', { author: 'human', message: 'human edit' })
    const last = await g.lastAgentCommit()
    expect(last?.sha).toBe(agentSha)
    expect(last?.authorName).toBe('agentkeep-agent')
  })

  it('lastAgentCommit is null when the agent has never written', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'h.md'), 'human\n')
    await g.commitChange('h.md', { author: 'human', message: 'human edit' })
    expect(await g.lastAgentCommit()).toBeNull()
  })

  it('lastAuthor maps the latest commit on a path back to agent/human', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'human seed' })
    expect(await g.lastAuthor('note.md')).toBe('human')
    await writeFile(join(dir, 'note.md'), 'v2 by agent\n')
    await g.commitChange('note.md', { author: 'agent', message: 'agent edit' })
    // The MOST RECENT touch is the agent's.
    expect(await g.lastAuthor('note.md')).toBe('agent')
  })

  it('lastAuthor is null for an untracked path', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    expect(await g.lastAuthor('never.md')).toBeNull()
  })

  it('noteHistory lists a path’s commits newest-first with correct authors', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'human seed' })
    await writeFile(join(dir, 'note.md'), 'v2 by agent\n')
    await g.commitChange('note.md', { author: 'agent', message: 'agent edit' })
    const hist = await g.noteHistory('note.md')
    expect(hist.length).toBe(2)
    // Newest first: the agent's edit, then the human's seed.
    expect(hist[0]?.author).toBe('agent')
    expect(hist[0]?.message).toContain('agent edit')
    expect(hist[0]?.sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(hist[0]?.dateISO).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(hist[1]?.author).toBe('human')
    expect(hist[1]?.message).toContain('human seed')
  })

  it('noteHistory honors the limit and is empty for an untracked path', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    expect(await g.noteHistory('never.md')).toEqual([])
    await writeFile(join(dir, 'note.md'), 'a\n')
    await g.commitChange('note.md', { author: 'human', message: 'one' })
    await writeFile(join(dir, 'note.md'), 'b\n')
    await g.commitChange('note.md', { author: 'agent', message: 'two' })
    await writeFile(join(dir, 'note.md'), 'c\n')
    await g.commitChange('note.md', { author: 'human', message: 'three' })
    const limited = await g.noteHistory('note.md', 2)
    expect(limited.length).toBe(2)
    expect(limited[0]?.message).toContain('three')
    expect(limited[1]?.message).toContain('two')
  })

  it('recentAgentCommits lists only agent commits, newest first, with date + path', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'a.md'), 'one\n')
    const sha1 = await g.commitChange('a.md', { author: 'agent', message: 'agent: file a' })
    await writeFile(join(dir, 'h.md'), 'human\n')
    await g.commitChange('h.md', { author: 'human', message: 'human edit' })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'memory/fact.md'), 'fact\n')
    const sha2 = await g.commitChange('memory/fact.md', { author: 'agent', message: 'agent: remember fact' })

    const commits = await g.recentAgentCommits(10)
    expect(commits.map((c) => c.sha)).toEqual([sha2, sha1])
    expect(commits[0]?.message).toBe('agent: remember fact')
    expect(commits[0]?.path).toBe('memory/fact.md')
    expect(commits[1]?.path).toBe('a.md')
    // strict-ISO author dates
    for (const c of commits) expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // the human commit is excluded
    expect(commits.some((c) => c.message === 'human edit')).toBe(false)
  })

  it('recentAgentCommits honors the limit', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    for (const n of ['one', 'two', 'three']) {
      await writeFile(join(dir, `${n}.md`), `${n}\n`)
      await g.commitChange(`${n}.md`, { author: 'agent', message: `agent: ${n}` })
    }
    const commits = await g.recentAgentCommits(2)
    expect(commits).toHaveLength(2)
    expect(commits[0]?.message).toBe('agent: three')
    expect(commits[1]?.message).toBe('agent: two')
  })

  it('recentAgentCommits is empty when the agent never wrote (and on an empty repo)', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    // empty repo — no commits at all
    expect(await g.recentAgentCommits(5)).toEqual([])
    await writeFile(join(dir, 'h.md'), 'human\n')
    await g.commitChange('h.md', { author: 'human', message: 'human edit' })
    expect(await g.recentAgentCommits(5)).toEqual([])
  })

  it('revertCommit undoes an agent change as a new human commit', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'seed' })
    await writeFile(join(dir, 'note.md'), 'v2 by agent\n')
    const agentSha = await g.commitChange('note.md', { author: 'agent', message: 'agent: change' })
    const revertSha = await g.revertCommit(agentSha)
    expect(revertSha).toMatch(/^[0-9a-f]{7,40}$/)
    // The agent's change is undone (back to v1) and the revert is the human's.
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe('v1\n')
    const head = await g.headCommit()
    expect(head?.authorName).toBe('agentkeep-human')
    expect(head?.message).toContain('Revert')
  })
})

// Git safety must be checked at MUTATION time, not just once at openVault: a
// vault that becomes dirty/mid-merge/detached AFTER startup must still be
// rejected on the next write, not silently committed into.
describe('VaultGit mutation-time preflight', () => {
  it('rejects commitChange when a merge is in progress (MERGE_HEAD present)', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'seed' })
    // Simulate an in-progress merge (as if a conflicting `git merge` were left mid-way).
    await writeFile(join(dir, '.git', 'MERGE_HEAD'), (await g.headCommit())!.sha + '\n')

    await writeFile(join(dir, 'note.md'), 'v2\n')
    await expect(g.commitChange('note.md', { author: 'agent', message: 'agent: edit' })).rejects.toMatchObject({
      name: 'GitStateError',
      code: 'merge-in-progress',
    })
    // The unsafe state was never committed into.
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe('v2\n')
    const last = await g.lastCommit('note.md')
    expect(last?.message).toBe('seed')
  })

  it('rejects removePath when a rebase is in progress (rebase-merge dir present)', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'seed' })
    await mkdir(join(dir, '.git', 'rebase-merge'), { recursive: true })

    await expect(g.removePath('note.md', { author: 'agent', message: 'agent: delete' })).rejects.toMatchObject({
      name: 'GitStateError',
      code: 'merge-in-progress',
    })
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe('v1\n')
  })

  it('rejects a mutation when tracked files OTHER than the target path are dirty', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await writeFile(join(dir, 'other.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'seed note' })
    await g.commitChange('other.md', { author: 'human', message: 'seed other' })
    // Dirty an UNRELATED tracked file outside of agentkeep (e.g. edited directly
    // in Obsidian while the app was running).
    await writeFile(join(dir, 'other.md'), 'changed outside agentkeep\n')

    await writeFile(join(dir, 'note.md'), 'v2\n')
    await expect(g.commitChange('note.md', { author: 'agent', message: 'agent: edit' })).rejects.toMatchObject({
      name: 'GitStateError',
      code: 'dirty-unrelated',
    })
    // other.md's unrelated edit is untouched, and note.md was never committed.
    expect(await readFile(join(dir, 'other.md'), 'utf8')).toBe('changed outside agentkeep\n')
    const last = await g.lastCommit('note.md')
    expect(last?.message).toBe('seed note')
  })

  it('rejects a mutation on a detached HEAD', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    const sha = await g.commitChange('note.md', { author: 'human', message: 'seed' })
    await simpleGit(dir).checkout(sha) // detach HEAD at the seed commit

    await writeFile(join(dir, 'note.md'), 'v2\n')
    await expect(g.commitChange('note.md', { author: 'agent', message: 'agent: edit' })).rejects.toMatchObject({
      name: 'GitStateError',
      code: 'detached-head',
    })
  })

  it('allows the target path spelled as a raw-string ALIAS (double slash) of itself — normalizes before comparing', async () => {
    // `a/n.md` and `a//n.md` are different raw pathspecs but the SAME physical
    // file. git's own status/pathspec machinery normalizes the double slash, so
    // the preflight's dirty-vs-target comparison must too — otherwise writing
    // through the alias spelling would see its OWN just-committed path as an
    // "unrelated" dirty file and wrongly refuse (a real flake this preflight
    // introduced before the fix: write-core's abs-keyed mutex legitimately lets
    // two alias-spelled writes to the same file race one another).
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await mkdir(join(dir, 'a'), { recursive: true })
    await writeFile(join(dir, 'a', 'n.md'), 'v1\n')
    await g.commitChange('a/n.md', { author: 'human', message: 'seed' })
    await writeFile(join(dir, 'a', 'n.md'), 'v2\n')
    const sha = await g.commitChange('a//n.md', { author: 'agent', message: 'agent: edit via alias' })
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
  })

  it('allows a normal write when the vault is clean and the target path itself is dirty', async () => {
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await writeFile(join(dir, 'note.md'), 'v1\n')
    await g.commitChange('note.md', { author: 'human', message: 'seed' })
    // Dirty ONLY the path being intentionally mutated — this is the normal
    // write-core flow (write to disk, then commit that exact path).
    await writeFile(join(dir, 'note.md'), 'v2\n')
    const sha = await g.commitChange('note.md', { author: 'agent', message: 'agent: edit' })
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
  })
})
