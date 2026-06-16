import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { readNote } from './frontmatter.js'
import { readTask, type Task } from './task.js'
import {
  applyProposal,
  savePendingProposals,
  loadPendingProposals,
  dismissProposal,
  stampProposalBases,
  type Proposal,
} from './proposal.js'

let dir: string
let vault: Vault
let git: VaultGit
let core: WriteCore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-proposal-'))
  vault = new Vault(dir)
  git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(vault, git)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const task = (over: Partial<Task> = {}): Task => ({
  id: 't_1', title: 'a task', status: 'inbox', created: '2026-06-08T09:00:00Z', ...over,
})

describe('applyProposal', () => {
  it('applies a writeNote + writeTask proposal, both committed as agent', async () => {
    const p: Proposal = {
      id: 'p_1', summary: 'file it', rationale: 'because', source: 'inbox/cap_x.md',
      ops: [
        { kind: 'writeNote', path: 'notes/n.md', content: '# A note\n' },
        { kind: 'writeTask', task: task() },
      ],
    }
    const res = await applyProposal(core,p)
    expect(res.applied).toBe(true)
    expect(res.commits).toHaveLength(2)

    expect((await core.read('notes/n.md'))?.content).toBe('# A note\n')
    expect(await readTask(core, 't_1')).toEqual(task())
    // both writes are agent-authored
    expect((await git.lastCommit('notes/n.md'))?.authorName).toBe('agentkeep-agent')
    expect((await git.lastCommit('tasks/t_1.json'))?.authorName).toBe('agentkeep-agent')
  })

  it('a setFrontmatter op changes only the key and preserves the rest of the note', async () => {
    await core.write('notes/n.md', '---\ntitle: Keep me\nstatus: open\n---\n\n# Body stays\n', { author: 'human', baseHash: null })
    const p: Proposal = {
      id: 'p_2', summary: 'close', rationale: 'done',
      ops: [{ kind: 'setFrontmatter', path: 'notes/n.md', key: 'status', value: 'closed' }],
    }
    const res = await applyProposal(core,p)
    expect(res.applied).toBe(true)

    const { data, body } = readNote((await core.read('notes/n.md'))!.content)
    expect(data.status).toBe('closed')
    expect(data.title).toBe('Keep me') // other key preserved
    expect(body).toContain('# Body stays') // body preserved
  })

  it('a deleteNote op removes the file and commits the deletion as agent', async () => {
    await core.write('inbox/cap_x.md', '# capture\n', { author: 'human', baseHash: null })
    const p: Proposal = {
      id: 'p_3', summary: 'file the capture', rationale: 'filed',
      ops: [{ kind: 'deleteNote', path: 'inbox/cap_x.md' }],
    }
    const res = await applyProposal(core,p)
    expect(res.applied).toBe(true)
    expect(await core.read('inbox/cap_x.md')).toBeNull()
    await expect(readFile(join(dir, 'inbox/cap_x.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('partial-failure: stops on the first failing op, returns applied:false + the commits done so far (no rollback)', async () => {
    // Pre-create the note so a writeNote with the daemon expecting create... actually
    // the engine reads current hash, so writeNote always succeeds. Force a failure
    // on the SECOND op via a deleteNote of a path that does not exist.
    const p: Proposal = {
      id: 'p_4', summary: 'two ops', rationale: 'x',
      ops: [
        { kind: 'writeTask', task: task({ id: 't_ok' }) },
        { kind: 'deleteNote', path: 'inbox/does-not-exist.md' },
      ],
    }
    const res = await applyProposal(core,p)
    expect(res.applied).toBe(false)
    expect(res.commits).toHaveLength(1) // the first op committed; no rollback
    expect(await readTask(core, 't_ok')).not.toBeNull() // git history is the safety net
  })
})

describe('propose-time baseHash', () => {
  it('stampProposalBases stamps existing-file hash and null for new files', async () => {
    await core.write('a.md', 'original', { author: 'human', baseHash: null })
    const r = await core.read('a.md')
    const proposals: Proposal[] = [{
      id: 'p1', summary: 's', rationale: 'r',
      ops: [
        { kind: 'writeNote', path: 'a.md', content: 'agent version' },
        { kind: 'writeNote', path: 'new.md', content: 'fresh' },
      ],
    }]
    const stamped = await stampProposalBases(core, proposals)
    expect(stamped[0]!.ops[0]).toMatchObject({ baseHash: r!.hash })
    expect(stamped[0]!.ops[1]).toMatchObject({ baseHash: null })
  })

  it('a human edit between propose and approve surfaces as a conflict, not a clobber', async () => {
    await core.write('a.md', 'original', { author: 'human', baseHash: null })
    const stamped = await stampProposalBases(core, [{
      id: 'p1', summary: 's', rationale: 'r',
      ops: [{ kind: 'writeNote', path: 'a.md', content: 'agent version' }],
    }])
    const r = await core.read('a.md')
    await core.write('a.md', 'human edit wins', { author: 'human', baseHash: r!.hash })
    const result = await applyProposal(core,stamped[0]!)
    expect(result.applied).toBe(false)
    expect(result.error?.name).toBe('ConflictError')
    expect((await core.read('a.md'))!.content).toBe('human edit wins')
  })

  it('an op WITHOUT baseHash (legacy persisted proposal) keeps last-writer-wins', async () => {
    await core.write('a.md', 'original', { author: 'human', baseHash: null })
    const legacy: Proposal = {
      id: 'p1', summary: 's', rationale: 'r',
      ops: [{ kind: 'writeNote', path: 'a.md', content: 'agent version' }],
    }
    const result = await applyProposal(core,legacy)
    expect(result.applied).toBe(true)
    expect((await core.read('a.md'))!.content).toBe('agent version')
  })

  it('pins the limitation: two ops on the SAME path in one proposal — the second conflicts', async () => {
    // stampProposalBases assumes at most one op per target path: both ops get
    // stamped with the SAME on-disk hash, so the first op's own write makes the
    // second op's base stale.
    await core.write('a.md', 'original', { author: 'human', baseHash: null })
    const stamped = await stampProposalBases(core, [{
      id: 'p1', summary: 's', rationale: 'r',
      ops: [
        { kind: 'writeNote', path: 'a.md', content: 'first write' },
        { kind: 'writeNote', path: 'a.md', content: 'second write' },
      ],
    }])
    const result = await applyProposal(core,stamped[0]!)
    expect(result.applied).toBe(false)
    expect(result.commits).toHaveLength(1) // first op committed; second conflicted
    expect(result.error?.name).toBe('ConflictError')
    expect((await core.read('a.md'))!.content).toBe('first write')
  })

  it('stale baseHash on deleteNote blocks the delete', async () => {
    await core.write('a.md', 'original', { author: 'human', baseHash: null })
    const stamped = await stampProposalBases(core, [{
      id: 'p1', summary: 's', rationale: 'r',
      ops: [{ kind: 'deleteNote', path: 'a.md' }],
    }])
    const r = await core.read('a.md')
    await core.write('a.md', 'edited since', { author: 'human', baseHash: r!.hash })
    const result = await applyProposal(core,stamped[0]!)
    expect(result.applied).toBe(false)
    expect(await core.read('a.md')).not.toBeNull()
  })
})

describe('pending-proposal persistence (.agentkeep/proposals.json)', () => {
  const p = (id: string): Proposal => ({ id, summary: 's', rationale: 'r', ops: [] })

  it('save/load round-trips', async () => {
    const ps = [p('p_a'), p('p_b')]
    await savePendingProposals(vault, ps)
    expect(await loadPendingProposals(vault)).toEqual(ps)
  })

  it('loadPendingProposals returns [] when nothing is pending', async () => {
    expect(await loadPendingProposals(vault)).toEqual([])
  })

  it('dismissProposal removes one and leaves the vault prose untouched', async () => {
    await core.write('notes/n.md', '# untouched\n', { author: 'human', baseHash: null })
    await savePendingProposals(vault, [p('p_a'), p('p_b')])
    await dismissProposal(vault, 'p_a')
    expect((await loadPendingProposals(vault)).map((x) => x.id)).toEqual(['p_b'])
    // dismiss is not an apply — vault prose unchanged
    expect((await core.read('notes/n.md'))?.content).toBe('# untouched\n')
  })

  it('writes app state to .agentkeep/proposals.json, not through the vault prose path', async () => {
    await mkdir(join(dir, '.agentkeep'), { recursive: true }).catch(() => {})
    await savePendingProposals(vault, [p('p_a')])
    const raw = await readFile(join(dir, '.agentkeep/proposals.json'), 'utf8')
    expect(JSON.parse(raw)[0].id).toBe('p_a')
  })
})
