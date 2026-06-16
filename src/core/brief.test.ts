import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { Indexer } from './indexer.js'
import { writeTask, type Task } from './task.js'
import { savePendingProposals, type Proposal } from './proposal.js'
import { generateBrief, renderBrief, runMorningBrief } from './brief.js'

const DATE = '2026-06-08'

let dir: string
let vault: Vault
let core: WriteCore
let indexer: Indexer
let deps: { vault: Vault; core: WriteCore; indexer: Indexer }

const task = (over: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  status: 'inbox',
  created: '2026-06-01T00:00:00Z',
  ...over,
})

async function seed() {
  // 2 done loops
  await writeTask(core, task({ id: 't_done1', title: 'email Sam', status: 'done' }), 'agent', null)
  await writeTask(core, task({ id: 't_done2', title: 'replied to Mira', status: 'done' }), 'agent', null)
  // 1 today (also matches the north-star goal "Ship Agentkeep v1" via tag)
  await writeTask(
    core,
    task({ id: 't_today', title: 'write the brief', status: 'today', priority: 'high', tags: ['agentkeep'] }),
    'agent',
    null,
  )
  // 1 due-today
  await writeTask(core, task({ id: 't_due', title: 'pay rent', due: DATE }), 'agent', null)
  // A doing task whose title-note is the backlink target. Its title matches the
  // target note's basename SLUG (the surfacer resolves active titles → note
  // paths by basename), but the note's human title differs — so a brief that
  // leaks the slug instead of the title is observably wrong.
  await writeTask(core, task({ id: 't_doing', title: 'deep-note', status: 'doing' }), 'agent', null)

  // north-star with a goal that matches the today task
  await core.write('north-star.md', '- Ship Agentkeep v1\n- Rest more\n', { author: 'human', baseHash: null })

  // A backlink pair where the file SLUGS differ from the human titles. The
  // target gets its title from the `# H1`; the source carries a frontmatter
  // `title:`. A correct brief surfaces "Deep Note"/"Q3 invoice for Sam", never
  // the "deep-note"/"0914-sam-invoice" slugs.
  await core.write('notes/deep-note.md', '# Deep Note\n\nthe note\n', { author: 'human', baseHash: null })
  await core.write(
    'notes/0914-sam-invoice.md',
    '---\ntitle: Q3 invoice for Sam\n---\nsee [[deep-note]]\n',
    { author: 'human', baseHash: null },
  )
  await indexer.reindexAll()

  // 1 pending proposal
  const proposal: Proposal = {
    id: 'prop_1',
    summary: 'File "old idea" capture into notes/',
    rationale: 'looks like a note',
    ops: [],
  }
  await savePendingProposals(vault, [proposal])
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-brief-'))
  vault = new Vault(dir)
  const git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(vault, git)
  indexer = new Indexer(vault)
  deps = { vault, core, indexer }
  await seed()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('generateBrief', () => {
  it('counts loops closed overnight and items needing you', async () => {
    const data = await generateBrief(deps, { date: DATE })
    expect(data.loopsClosedOvernight).toBe(2)
    expect(data.needYou).toBe(1)
    expect(data.needsYourEyes).toHaveLength(1)
  })

  it('today = status:today OR due:date, sorted (priority then title)', async () => {
    const data = await generateBrief(deps, { date: DATE })
    expect(data.today.map((t) => t.id)).toEqual(['t_today', 't_due'])
  })

  it('whatMatters maps north-star goals to matching tasks', async () => {
    const data = await generateBrief(deps, { date: DATE })
    const ship = data.whatMatters.find((w) => w.goal === 'Ship Agentkeep v1')
    expect(ship).toBeTruthy()
    expect(ship!.items.map((t) => t.id)).toContain('t_today')
    // the goal with no matching task is dropped
    expect(data.whatMatters.find((w) => w.goal === 'Rest more')).toBeUndefined()
  })

  it('oneConnection surfaces a backlink edge using note TITLES (not slugs)', async () => {
    const data = await generateBrief(deps, { date: DATE })
    expect(data.oneConnection).not.toBeNull()
    // from/to are human titles, not the "0914-sam-invoice"/"deep-note" slugs.
    expect(data.oneConnection!.to).toBe('Deep Note')
    expect(data.oneConnection!.from).toBe('Q3 invoice for Sam')
    expect(data.oneConnection!.why).not.toMatch(/still on your plate/i)
    expect(data.oneConnection!.why).not.toMatch(/0914-sam-invoice|deep-note/)
    // source stays a path — it's shown small/mono as a cite.
    expect(data.oneConnection!.source).toBe('notes/0914-sam-invoice.md')
  })

  it('loopsClosedOvernight with sinceISO + closedAt counts only fresh closes', async () => {
    // mark one done task as closed BEFORE the window, one AFTER
    await writeTask(
      core,
      task({ id: 't_done1', title: 'email Sam', status: 'done', closedAt: '2026-06-07T10:00:00Z' }),
      'agent',
      // overwrite (read-modify-write): fetch fresh hash
      (await core.read('tasks/t_done1.json'))!.hash,
    )
    await writeTask(
      core,
      task({ id: 't_done2', title: 'replied to Mira', status: 'done', closedAt: '2026-06-08T02:00:00Z' }),
      'agent',
      (await core.read('tasks/t_done2.json'))!.hash,
    )
    const data = await generateBrief(deps, { date: DATE, sinceISO: '2026-06-08T00:00:00Z' })
    expect(data.loopsClosedOvernight).toBe(1)
  })
})

describe('renderBrief', () => {
  it('leads with the loops/need-you line and renders every section', async () => {
    const data = await generateBrief(deps, { date: DATE })
    const md = renderBrief(data)
    expect(md).toContain('# 2 loops closed overnight · 1 need you')
    expect(md).toContain('## Today')
    expect(md).toContain('- [ ] write the brief')
    expect(md).toContain('## What matters')
    expect(md).toContain('Ship Agentkeep v1')
    expect(md).toContain('## One connection you')
    expect(md).toContain('cites:')
    expect(md).toContain('## Needs your eyes')
    expect(md).toContain('File "old idea" capture into notes/')
  })

  it('renders the connection with note TITLES and plain prose (no slugs, no filler)', async () => {
    const data = await generateBrief(deps, { date: DATE })
    const md = renderBrief(data)
    // human titles, not file slugs
    expect(md).toContain('Deep Note')
    expect(md).toContain('Q3 invoice for Sam')
    // the PROSE line uses titles, not slugs (the cite line keeps the path).
    expect(data.oneConnection!.why).not.toContain('0914-sam-invoice')
    expect(data.oneConnection!.why).not.toContain('deep-note')
    // plain, factual phrasing — no twee filler
    expect(md).not.toMatch(/still on your plate/i)
    expect(md).not.toMatch(/while you slept/i)
    expect(md).not.toMatch(/kept watch/i)
  })

  it('renders the connection prose plainly from a Connection of titles', () => {
    const md = renderBrief({
      date: DATE,
      loopsClosedOvernight: 0,
      needYou: 0,
      today: [],
      whatMatters: [],
      oneConnection: {
        from: 'Q3 invoice for Sam',
        to: 'Deep Note',
        why: 'You linked Deep Note from Q3 invoice for Sam.',
        source: 'notes/0914-sam-invoice.md',
      },
      needsYourEyes: [],
    })
    expect(md).toContain('You linked Deep Note from Q3 invoice for Sam.')
    expect(md).toContain('cites: [[0914-sam-invoice]]')
  })

  it('attributes a done task to the agent ONLY when closedBy is agent', () => {
    const base = {
      date: DATE,
      loopsClosedOvernight: 0,
      needYou: 0,
      whatMatters: [],
      oneConnection: null,
      needsYourEyes: [],
    }
    // closedBy:'agent' → honest agent attribution
    const agentMd = renderBrief({
      ...base,
      today: [task({ id: 't_a', title: 'email Sam', status: 'done', closedBy: 'agent' })],
    })
    expect(agentMd).toContain('- [x] email Sam — closed by your agent')

    // no closedBy recorded → done, but NO agent claim (don't out-claim the engine)
    const unknownMd = renderBrief({
      ...base,
      today: [task({ id: 't_u', title: 'pay rent', status: 'done' })],
    })
    expect(unknownMd).toContain('- [x] pay rent')
    expect(unknownMd).not.toContain('closed by your agent')

    // closedBy:'human' → the human closed it; never claim the agent
    const humanMd = renderBrief({
      ...base,
      today: [task({ id: 't_h', title: 'call bank', status: 'done', closedBy: 'human' })],
    })
    expect(humanMd).toContain('- [x] call bank')
    expect(humanMd).not.toContain('closed by your agent')
  })

  it('omits the connection section when there is none', () => {
    const md = renderBrief({
      date: DATE,
      loopsClosedOvernight: 0,
      needYou: 0,
      today: [],
      whatMatters: [],
      oneConnection: null,
      needsYourEyes: [],
    })
    expect(md).not.toContain('## One connection')
    expect(md).not.toContain('## Needs your eyes')
  })
})

describe('runMorningBrief', () => {
  it('writes brief/<date>.md as the agent', async () => {
    const { path } = await runMorningBrief(deps, { date: DATE })
    expect(path).toBe('brief/2026-06-08.md')
    const written = await core.read(path)
    expect(written).not.toBeNull()
    expect(written!.content).toContain('# 2 loops closed overnight · 1 need you')

    const git = new VaultGit(dir)
    expect((await git.lastCommit(path))?.authorName).toBe('agentkeep-agent')
  })

  it('re-running the same day overwrites cleanly (CAS, no conflict)', async () => {
    await runMorningBrief(deps, { date: DATE })
    // close another loop, re-run same day
    await writeTask(core, task({ id: 't_done3', title: 'shipped it', status: 'done' }), 'agent', null)
    indexer = new Indexer(vault)
    await indexer.reindexAll()
    deps = { vault, core, indexer }
    const second = await runMorningBrief(deps, { date: DATE })
    expect(second.data.loopsClosedOvernight).toBe(3)
    const written = await core.read('brief/2026-06-08.md')
    expect(written!.content).toContain('# 3 loops closed overnight · 1 need you')
  })
})
