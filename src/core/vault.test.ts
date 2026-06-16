import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault.js'
import { VaultPathError } from './errors.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ak-vault-'))
  await mkdir(join(dir, 'notes'), { recursive: true })
  await writeFile(join(dir, 'notes', 'a.md'), '# A\n')
  await writeFile(join(dir, 'notes', 'b.md'), '# B\n')
  await writeFile(join(dir, 'README.txt'), 'ignore me\n')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('Vault', () => {
  it('resolves a relative note path to an absolute path under the root', () => {
    const v = new Vault(dir)
    expect(v.abs('notes/a.md')).toBe(join(dir, 'notes', 'a.md'))
  })
  it('rejects path traversal outside the root', () => {
    const v = new Vault(dir)
    expect(() => v.abs('../escape.md')).toThrow(VaultPathError)
    expect(() => v.abs('/etc/passwd')).toThrow(VaultPathError)
  })
  it('lists only markdown files, relative and sorted', async () => {
    const v = new Vault(dir)
    expect(await v.listMarkdown()).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('rejects an in-vault symlink that points OUTSIDE the root (realpath guard)', async () => {
    // outside/ holds a secret file the vault must never reach
    const outside = await mkdtemp(join(tmpdir(), 'ak-outside-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'top secret\n')
      // a symlink inside the vault pointing at the outside directory
      await symlink(outside, join(dir, 'link'))
      const v = new Vault(dir)
      // lexically this looks in-bounds (link/secret.md), but realpath escapes
      await expect(v.resolveSafe('link/secret.md')).rejects.toThrow(VaultPathError)
      // a symlinked dir that does not yet contain the target is still rejected
      await expect(v.resolveSafe('link/new.md')).rejects.toThrow(VaultPathError)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('resolveSafe allows a real in-vault path and returns its absolute path', async () => {
    const v = new Vault(dir)
    expect(await v.resolveSafe('notes/a.md')).toBe(v.abs('notes/a.md'))
  })

  it('resolveSafe still rejects pure lexical traversal', async () => {
    const v = new Vault(dir)
    await expect(v.resolveSafe('../escape.md')).rejects.toThrow(VaultPathError)
    await expect(v.resolveSafe('/etc/passwd')).rejects.toThrow(VaultPathError)
  })
})
