import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { readNote } from './frontmatter.js'
import { newId } from './ids.js'
import { captureToInbox } from './capture.js'

let dir: string
let core: WriteCore
let git: VaultGit
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-capture-'))
  git = new VaultGit(dir)
  await git.ensureRepo()
  core = new WriteCore(new Vault(dir), git)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('captureToInbox', () => {
  it('writes an inbox md with id/created/type frontmatter and the body, committed as human', async () => {
    const text = 'email Sam about the invoice'
    const { path, id } = await captureToInbox(core, text, { createdISO: '2026-06-08T09:00:00Z' })

    expect(id).toBe(newId('cap', text))
    expect(path).toBe(`inbox/${id}.md`)

    const r = await core.read(path)
    expect(r).not.toBeNull()
    const { data, body } = readNote(r!.content)
    expect(data.id).toBe(id)
    expect(data.created).toBe('2026-06-08T09:00:00Z')
    expect(data.type).toBe('capture')
    expect(body.trim()).toBe(text)

    // committed as the human (not the agent) — capture is a human action
    const last = await git.lastCommit(path)
    expect(last?.authorName).toBe('agentkeep-human')
  })

  it('capturing different text yields a different inbox file', async () => {
    const a = await captureToInbox(core, 'first thing')
    const b = await captureToInbox(core, 'second thing')
    expect(a.id).not.toBe(b.id)
    expect(a.path).not.toBe(b.path)
    expect(await core.read(a.path)).not.toBeNull()
    expect(await core.read(b.path)).not.toBeNull()
  })

  it('capturing identical text is idempotent and does not rewrite the existing capture', async () => {
    const first = await captureToInbox(core, 'same thought', { createdISO: '2026-06-08T09:00:00Z' })
    const second = await captureToInbox(core, 'same thought', { createdISO: '2026-06-09T10:00:00Z' })

    expect(second).toEqual(first)
    const r = await core.read(first.path)
    expect(r).not.toBeNull()
    const { data, body } = readNote(r!.content)
    expect(data.created).toBe('2026-06-08T09:00:00Z')
    expect(body.trim()).toBe('same thought')
    expect(await git.noteHistory(first.path)).toHaveLength(1)
  })
})
