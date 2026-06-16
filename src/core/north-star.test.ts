import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { newId } from './ids.js'
import { readNorthStar } from './north-star.js'

let dir: string
let core: WriteCore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-ns-'))
  const vault = new Vault(dir)
  const git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(vault, git)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const write = (content: string) =>
  core.write('north-star.md', content, { author: 'human', baseHash: null })

describe('readNorthStar', () => {
  it('parses 3 top-level bullet goals into stable, content-derived ids', async () => {
    await write('# North Star\n\n- Ship Agentkeep v1\n- Grow the audience\n- Stay healthy\n')
    const { goals } = await readNorthStar(core)
    expect(goals.map((g) => g.text)).toEqual([
      'Ship Agentkeep v1',
      'Grow the audience',
      'Stay healthy',
    ])
    expect(goals[0]!.id).toBe(newId('goal', 'Ship Agentkeep v1'))
    // stable across re-reads
    const again = await readNorthStar(core)
    expect(again.goals).toEqual(goals)
  })

  it('treats `## ` headings as goals too', async () => {
    await write('## Money\n\nsome prose\n\n## Health\n')
    const { goals } = await readNorthStar(core)
    expect(goals.map((g) => g.text)).toEqual(['Money', 'Health'])
  })

  it('ignores frontmatter and non-goal prose', async () => {
    await write('---\ntitle: North Star\npinned: true\n---\nJust a paragraph, not a goal.\n')
    const { goals } = await readNorthStar(core)
    expect(goals).toEqual([])
  })

  it('dedupes goals by text', async () => {
    await write('- Ship it\n- Ship it\n- Rest\n')
    const { goals } = await readNorthStar(core)
    expect(goals.map((g) => g.text)).toEqual(['Ship it', 'Rest'])
  })

  it('returns no goals when north-star.md is missing', async () => {
    expect(await readNorthStar(core)).toEqual({ goals: [] })
  })
})
