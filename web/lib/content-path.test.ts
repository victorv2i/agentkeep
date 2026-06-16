import { describe, it, expect } from 'vitest'
import { isContentPath, isNotePath } from './content-path'

// These guards close the unauthenticated-write/read hole: Vault.resolveSafe
// blocks escaping the vault ROOT but still permits in-root dotfolders, so
// without this guard a caller could read or write `.git/config` (→ RCE) through
// the editor's load/save server actions.

describe('isNotePath', () => {
  it('accepts an ordinary markdown note (case-insensitive extension)', () => {
    expect(isNotePath('memory/payee-rules.md')).toBe(true)
    expect(isNotePath('notes/Foo.md')).toBe(true)
    expect(isNotePath('Foo.MD')).toBe(true)
  })

  it('rejects dotfolder paths — the .git/config RCE + secret-read vector', () => {
    expect(isNotePath('.git/config')).toBe(false)
    expect(isNotePath('.git/hooks/pre-commit')).toBe(false)
    expect(isNotePath('.obsidian/workspace.json')).toBe(false)
    expect(isNotePath('.agentkeep/config.json')).toBe(false)
  })

  it('rejects a hidden file even when it ends in .md', () => {
    expect(isNotePath('memory/.secret.md')).toBe(false)
  })

  it('rejects a non-markdown file even in a normal folder', () => {
    expect(isNotePath('photos/cat.png')).toBe(false)
    expect(isNotePath('notes/data.json')).toBe(false)
  })

  it('rejects traversal, absolute, and empty paths', () => {
    expect(isNotePath('../outside.md')).toBe(false)
    expect(isNotePath('a/../../b.md')).toBe(false)
    expect(isNotePath('/etc/passwd.md')).toBe(false)
    expect(isNotePath('')).toBe(false)
  })
})

describe('isContentPath', () => {
  it('accepts ordinary content including non-markdown assets', () => {
    expect(isContentPath('photos/cat.png')).toBe(true)
    expect(isContentPath('memory/foo.md')).toBe(true)
  })

  it('rejects dotfolders, traversal, and absolute paths (image-route hardening)', () => {
    expect(isContentPath('.git/config')).toBe(false)
    expect(isContentPath('.obsidian/x.svg')).toBe(false)
    expect(isContentPath('../../etc/passwd')).toBe(false)
    expect(isContentPath('/abs/path.png')).toBe(false)
    expect(isContentPath('')).toBe(false)
  })
})
