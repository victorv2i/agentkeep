import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { Indexer } from './indexer.js'
import { MockMaker } from './maker.js'
import { captureToInbox } from './capture.js'
import { listTasks } from './task.js'
import { loadPendingProposals } from './proposal.js'
import { runAgentOnce, approveAll, approve } from './agent-loop.js'

let dir: string
let vault: Vault
let git: VaultGit
let core: WriteCore
let indexer: Indexer
let deps: { vault: Vault; core: WriteCore; indexer: Indexer; maker: MockMaker }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-loop-'))
  vault = new Vault(dir)
  git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(vault, git)
  indexer = new Indexer(vault)
  deps = { vault, core, indexer, maker: new MockMaker() }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('agent loop (propose → approve)', () => {
  it('runAgentOnce proposes for each inbox capture but mutates nothing', async () => {
    const a = await captureToInbox(core, 'email Sam about the invoice')
    const b = await captureToInbox(core, 'replied to Mira')

    const { proposals } = await runAgentOnce(deps)
    expect(proposals).toHaveLength(2)

    // persisted as pending app state
    const pending = await loadPendingProposals(vault)
    expect(pending.map((p) => p.id)).toEqual(proposals.map((p) => p.id))
    const raw = await readFile(join(dir, '.agentkeep/proposals.json'), 'utf8')
    expect(JSON.parse(raw)).toHaveLength(2)

    // NOTHING applied yet: inbox files still present, no tasks written
    expect(await core.read(a.path)).not.toBeNull()
    expect(await core.read(b.path)).not.toBeNull()
    expect(await listTasks(vault)).toEqual([])
  })

  it('approveAll applies the proposals: inbox cleared, tasks created as agent, pending cleared', async () => {
    const a = await captureToInbox(core, 'email Sam about the invoice')
    const b = await captureToInbox(core, 'replied to Mira')
    const { proposals } = await runAgentOnce(deps)

    const results = await approveAll(deps, proposals)
    expect(results.every((r) => r.applied)).toBe(true)

    // inbox files are gone (filed)
    expect(await core.read(a.path)).toBeNull()
    expect(await core.read(b.path)).toBeNull()

    // two tasks now exist, committed as the agent
    const tasks = await listTasks(vault)
    expect(tasks).toHaveLength(2)
    expect((await git.lastCommit('tasks/' + tasks[0]!.id + '.json'))?.authorName).toBe('agentkeep-agent')

    // "replied to Mira" closed a loop
    const loopsClosed = tasks.filter((t) => t.status === 'done').length
    expect(loopsClosed).toBe(1)

    // pending is cleared
    expect(await loadPendingProposals(vault)).toEqual([])
  })

  it('approve applies a single proposal and leaves the others pending', async () => {
    await captureToInbox(core, 'email Sam about the invoice')
    await captureToInbox(core, 'replied to Mira')
    const { proposals } = await runAgentOnce(deps)

    const res = await approve(deps, proposals[0]!.id)
    expect(res.applied).toBe(true)

    // exactly one task filed; one proposal still pending
    expect(await listTasks(vault)).toHaveLength(1)
    const pending = await loadPendingProposals(vault)
    expect(pending.map((p) => p.id)).toEqual([proposals[1]!.id])
  })

  it('runAgentOnce persists STAMPED proposals (ops carry baseHash)', async () => {
    await captureToInbox(core, 'email Sam about the invoice')
    await runAgentOnce(deps)
    const pending = await loadPendingProposals(vault)
    expect(pending.length).toBeGreaterThan(0)
    for (const p of pending) for (const op of p.ops) {
      expect('baseHash' in op).toBe(true)
    }
  })

  it('runAgentOnce on an empty inbox proposes nothing', async () => {
    const { proposals } = await runAgentOnce(deps)
    expect(proposals).toEqual([])
    expect(await loadPendingProposals(vault)).toEqual([])
  })
})
