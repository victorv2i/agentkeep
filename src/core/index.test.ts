import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { openVault, VaultGit } from './index.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-open-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('openVault', () => {
  it('opens a fresh folder, git-inits it, and snapshots a baseline commit', async () => {
    const ak = await openVault(dir)
    const log = await ak.git.lastCommit('.')
    expect(log?.message).toMatch(/baseline/i)
  })

  it('opens an EXISTING Obsidian-style vault without clobbering its files, then guards writes', async () => {
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'notes', 'existing.md'), '# Existing\nmy precious notes\n')
    const ak = await openVault(dir)

    // existing file is intact and readable through the core
    const r = await ak.core.read('notes/existing.md')
    expect(r?.content).toBe('# Existing\nmy precious notes\n')

    // a hash-guarded edit succeeds; a stale one is rejected
    const ok = await ak.core.write('notes/existing.md', '# Existing\nedited\n', { author: 'agent', baseHash: r!.hash })
    expect(ok.commit).toMatch(/^[0-9a-f]{7,40}$/)
    expect(ak.list).toBeInstanceOf(Function)
    expect(await ak.list()).toContain('notes/existing.md')
  })

  it('does NOT commit an existing Obsidian vault’s private config on open', async () => {
    // A fresh (non-git) "existing Obsidian vault": private app config + a real note.
    await mkdir(join(dir, '.obsidian'), { recursive: true })
    await writeFile(join(dir, '.obsidian', 'workspace.json'), '{"main":"layout"}\n')
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'notes', 'a.md'), '# A\nkeep this\n')

    await openVault(dir)

    const tracked = (await simpleGit(dir).raw(['ls-files'])).split('\n').filter(Boolean)
    // (a) the Obsidian config is NOT swept into git
    expect(tracked).not.toContain('.obsidian/workspace.json')
    // (c) the user's note IS tracked
    expect(tracked).toContain('notes/a.md')
    // (b) a root .gitignore was written that ignores .obsidian/
    const ignore = await readFile(join(dir, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^\.obsidian\/$/m)
    expect(ignore).toMatch(/^\.trash\/$/m)
    // (d) the note content is untouched on disk
    expect(await readFile(join(dir, 'notes', 'a.md'), 'utf8')).toBe('# A\nkeep this\n')
  })

  it('preserves an existing root .gitignore unchanged on open', async () => {
    const existing = '# my rules\nnotes/secret/\n*.tmp\n'
    await writeFile(join(dir, '.gitignore'), existing)
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'notes', 'a.md'), '# A\n')

    await openVault(dir)

    // The user's own ignore rules are honored verbatim — never clobbered/appended.
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(existing)
  })

  it('refuses an existing dirty git vault before writing metadata or committing unrelated work', async () => {
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'notes', 'tracked.md'), '# Seed\n')
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await g.commitChange('notes/tracked.md', { author: 'human', message: 'seed tracked note' })

    await writeFile(join(dir, 'notes', 'tracked.md'), '# Changed outside agentkeep\n')
    await writeFile(join(dir, 'notes', 'untracked.md'), '# Untracked outside agentkeep\n')

    await expect(openVault(dir)).rejects.toThrow(/Refusing to open an existing git vault/)

    const status = await simpleGit(dir).raw(['status', '--porcelain=v1', '--untracked-files=all'])
    expect(status).toContain('notes/tracked.md')
    expect(status).toContain('notes/untracked.md')
    await expect(readFile(join(dir, '.agentkeep/config.json'), 'utf8')).rejects.toThrow()

    const log = await simpleGit(dir).log()
    expect(log.all.map((c) => c.message)).toEqual(['seed tracked note'])
  })

  it('opens a clean existing git vault by committing only Agentkeep metadata', async () => {
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'notes', 'tracked.md'), '# Seed\n')
    const g = new VaultGit(dir)
    await g.ensureRepo()
    await g.commitChange('notes/tracked.md', { author: 'human', message: 'seed tracked note' })

    await openVault(dir)

    const tracked = (await simpleGit(dir).raw(['ls-files'])).split('\n').filter(Boolean)
    expect(tracked).toContain('notes/tracked.md')
    expect(tracked).toContain('.agentkeep/config.json')
    expect(tracked).toContain('.agentkeep/.gitignore')

    const messages = (await simpleGit(dir).log()).all.map((c) => c.message)
    expect(messages).not.toContain('baseline: agentkeep opened vault')
    expect(messages.filter((m) => m === 'agentkeep: initialize vault metadata')).toHaveLength(2)
  })
})
