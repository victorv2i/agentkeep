import { describe, it, expect } from 'vitest'
import { isContentPath, isNotePath, isWikilinkTargetResolved } from './content-path'

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

// Shared wikilink-resolution rule for the editor's live-preview styling
// (`isResolved` in NotesClient.tsx) — it must agree with the core LinkGraph's
// resolver (src/core/link-graph.ts) and the server's `resolveTarget`
// (web/lib/vault.ts): a slash-bearing target requires an EXACT path match, a
// bare target matches by basename. Before this helper existed, the editor used
// basename-only matching for every target, so a slash-bearing `[[folder/Foo]]`
// could show as "resolved" in the editor while the click handler (which calls
// the server's resolveTarget) found nothing — an inconsistent placeholder
// state.
describe('isWikilinkTargetResolved', () => {
  const notes = [
    { path: 'notes/Foo.md', basename: 'Foo' },
    { path: 'folder/Foo.md', basename: 'Foo' },
    { path: 'notes/Bar.md', basename: 'Bar' },
  ]

  it('resolves a bare (no-slash) target by basename', () => {
    expect(isWikilinkTargetResolved('Bar', notes)).toBe(true)
    expect(isWikilinkTargetResolved('Missing', notes)).toBe(false)
  })

  it('resolves a slash-bearing target by EXACT path, not basename', () => {
    // A basename-only match would wrongly call this "resolved" (a note named
    // Foo exists elsewhere) even though no note lives at other/Foo.md.
    expect(isWikilinkTargetResolved('other/Foo', notes)).toBe(false)
    expect(isWikilinkTargetResolved('folder/Foo', notes)).toBe(true)
    expect(isWikilinkTargetResolved('folder/Foo.md', notes)).toBe(true)
  })

  it('treats an empty/whitespace target as unresolved', () => {
    expect(isWikilinkTargetResolved('', notes)).toBe(false)
    expect(isWikilinkTargetResolved('   ', notes)).toBe(false)
  })

  it('matches resolveTarget/LinkGraph\'s case split: basename is case-insensitive, a slash path is case-SENSITIVE', () => {
    expect(isWikilinkTargetResolved('bar', notes)).toBe(true)
    expect(isWikilinkTargetResolved('FOLDER/foo', notes)).toBe(false)
    expect(isWikilinkTargetResolved('folder/Foo', notes)).toBe(true)
  })
})
