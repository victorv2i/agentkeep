import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault, type Agentkeep } from './index.js'
import { VaultPathError } from './errors.js'

// resolveSafe blocks ESCAPING the vault root but deliberately permits in-root
// dotfolders (.git/, .obsidian/, .agentkeep/). The content-path guard used to
// live only in the web layer, so the MCP seam / agent loop could write into
// .git/ — e.g. a post-commit hook — which runs on the next commit (RCE). The
// guard must live in the core writer so EVERY entry point is covered.

let dir: string
let ak: Agentkeep
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-guard-'))
  ak = await openVault(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WriteCore rejects hidden (dotfolder) paths', () => {
  it('refuses to write a .git/ path (the agent-RCE vector) and leaves nothing on disk', async () => {
    await expect(
      ak.core.write('.git/hooks/post-commit', '#!/bin/sh\necho pwned\n', { author: 'agent', baseHash: null }),
    ).rejects.toBeInstanceOf(VaultPathError)
    await expect(readFile(join(dir, '.git/hooks/post-commit'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses .obsidian / .agentkeep / dotfile writes', async () => {
    for (const p of ['.obsidian/app.json', '.agentkeep/evil.json', 'notes/.secret.md']) {
      await expect(ak.core.write(p, 'x', { author: 'agent', baseHash: null })).rejects.toBeInstanceOf(VaultPathError)
    }
  })

  it('refuses to delete a .git/ path', async () => {
    await expect(ak.core.delete('.git/config', { author: 'agent' })).rejects.toBeInstanceOf(VaultPathError)
  })

  it('still allows ordinary content writes', async () => {
    const r = await ak.core.write('memory/fact.md', '# Fact\n', { author: 'agent', baseHash: null })
    expect(r.commit).toBeTruthy()
  })
})
