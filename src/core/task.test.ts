import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { ConflictError } from './errors.js'
import { taskPath, readTask, writeTask, listTasks, type Task } from './task.js'

let dir: string
let vault: Vault
let core: WriteCore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-task-'))
  vault = new Vault(dir)
  const git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(vault, git)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const sample = (over: Partial<Task> = {}): Task => ({
  id: 't_abc123',
  title: 'email Sam about the invoice',
  status: 'inbox',
  created: '2026-06-08T09:00:00Z',
  ...over,
})

describe('task model (sharded JSON)', () => {
  it('taskPath shards one file per task under tasks/', () => {
    expect(taskPath('t_abc123')).toBe('tasks/t_abc123.json')
  })

  it('writes pretty JSON with a trailing newline and round-trips through read', async () => {
    const t = sample({ due: '2026-06-10', priority: 'high', tags: ['invoice'], source: 'inbox/cap_x.md' })
    const res = await writeTask(core, t, 'agent', null)
    expect(res.commit).toMatch(/^[0-9a-f]{7,40}$/)

    const raw = await readFile(join(dir, taskPath(t.id)), 'utf8')
    expect(raw).toBe(JSON.stringify(t, null, 2) + '\n')

    expect(await readTask(core, t.id)).toEqual(t)
  })

  it('readTask returns null for a missing task', async () => {
    expect(await readTask(core, 't_nope')).toBeNull()
  })

  it('readTask returns null for a corrupt-but-present shard (no throw)', async () => {
    await core.write(taskPath('t_bad'), '{not json', { author: 'agent', baseHash: null })
    expect(await readTask(core, 't_bad')).toBeNull()
  })

  it('listTasks returns all tasks in the vault', async () => {
    await writeTask(core, sample({ id: 't_1', title: 'one' }), 'agent', null)
    await writeTask(core, sample({ id: 't_2', title: 'two', status: 'done' }), 'agent', null)
    const all = await listTasks(vault)
    expect(all.map((t) => t.id).sort()).toEqual(['t_1', 't_2'])
    expect(all.find((t) => t.id === 't_2')?.status).toBe('done')
  })

  it('rejects a stale write with ConflictError (reuses the core CAS)', async () => {
    const t = sample({ id: 't_cas' })
    const first = await writeTask(core, t, 'agent', null)
    // change it underneath using the fresh hash
    await writeTask(core, { ...t, title: 'changed' }, 'human', first.hash)
    // a writer holding the OLD hash is rejected
    await expect(
      writeTask(core, { ...t, title: 'stale' }, 'agent', first.hash),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})
