import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMcpVaultRoot } from './agentkeep-mcp.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ak-mcp-bin-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('resolveMcpVaultRoot', () => {
  it('requires a path and points users at init', async () => {
    await expect(resolveMcpVaultRoot(undefined, undefined)).rejects.toThrow(/agentkeep init <vault-path>/)
  })

  it('fails clearly when the vault folder does not exist', async () => {
    const missing = join(dir, 'missing-vault')
    await expect(resolveMcpVaultRoot(missing, undefined)).rejects.toThrow(`agentkeep init ${missing}`)
  })

  it('accepts an existing directory but rejects a file', async () => {
    await expect(resolveMcpVaultRoot(dir, undefined)).resolves.toBe(dir)
    const file = join(dir, 'not-a-vault')
    await writeFile(file, 'nope\n')
    await expect(resolveMcpVaultRoot(file, undefined)).rejects.toThrow(/not a directory/)
  })
})
