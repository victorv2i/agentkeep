import { readdir, realpath } from 'node:fs/promises'
import { join, resolve, relative, sep, isAbsolute, dirname } from 'node:path'
import { VaultPathError } from './errors.js'

export class Vault {
  readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * Lexical-only guard: resolve a vault-relative path to an absolute path and
   * reject obvious traversal (`..`, absolute inputs). This does NOT follow
   * symlinks — an in-vault symlink pointing outside still passes here. Use
   * `resolveSafe` for any real filesystem access; `abs` is fine for callers
   * that only need the lexical path (e.g. listing helpers).
   */
  abs(relPath: string): string {
    if (isAbsolute(relPath)) throw new VaultPathError(`Absolute path not allowed: ${relPath}`)
    const abs = resolve(this.root, relPath)
    const rel = relative(this.root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new VaultPathError(`Path escapes vault root: ${relPath}`)
    }
    return abs
  }

  /**
   * Lexical guard PLUS a symlink-aware guard: after the lexical check, resolve
   * symlinks on the deepest existing ancestor of the target and assert that real
   * path stays under the real vault root. This blocks a symlink *inside* the
   * vault that points *outside* it (read or write would otherwise follow it
   * out). Returns the lexical absolute path (the real on-disk target the caller
   * reads/writes); every access that touches the filesystem must go through it.
   */
  async resolveSafe(relPath: string): Promise<string> {
    // TODO(phase2): accepted TOCTOU window — we realpath-check here, then the
    // caller's atomicWrite resolves lexically and follows symlinks at write time.
    // Safe for a single-user local daemon (this process is the only writer; the
    // threat is an accidental in-vault symlink, not a hostile local race). If the
    // vault is ever exposed to an untrusted local process, move writes to an
    // O_NOFOLLOW / openat-based fd guard.
    const abs = this.abs(relPath)
    const realRoot = await realpath(this.root)
    // Walk up to the deepest ancestor that exists, then realpath it. A new file
    // (and its missing parents) cannot be realpath'd, but its existing parent
    // chain — including any escaping symlink — can.
    let probe = abs
    for (;;) {
      try {
        const realProbe = await realpath(probe)
        const rel = relative(realRoot, realProbe)
        if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
          throw new VaultPathError(`Path escapes vault root via symlink: ${relPath}`)
        }
        break
      } catch (err) {
        if (err instanceof VaultPathError) throw err
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        const parent = dirname(probe)
        if (parent === probe) break // reached filesystem root without finding an existing ancestor
        probe = parent
      }
    }
    return abs
  }

  /** Vault-relative paths of all markdown files, sorted. Ignores dotfolders. */
  async listMarkdown(): Promise<string[]> {
    const out: string[] = []
    const walk = async (absDir: string) => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const abs = join(absDir, entry.name)
        if (entry.isDirectory()) await walk(abs)
        else if (entry.name.endsWith('.md')) out.push(relative(this.root, abs).split(sep).join('/'))
      }
    }
    await walk(this.root)
    return out.sort()
  }
}

/**
 * Reject paths that are not vault content paths: hidden (dot-prefixed) segments,
 * Windows-style backslashes, and root-level leading dashes. `resolveSafe` blocks
 * escaping the vault ROOT but deliberately permits in-root dotfolders, so the
 * MUTATION path (WriteCore.write / delete) and the agent-exposed read seam must
 * reject them here: otherwise a connected agent could write `.git/hooks/*` (code
 * execution on the next commit) or read `.git/config` (secret leak). The app's
 * own reads of `.agentkeep/*` go through `core.read` directly and are unaffected.
 */
export function assertVaultContentPath(relPath: string): void {
  if (relPath.includes('\\')) {
    throw new VaultPathError(`Backslashes are not allowed in vault content paths: ${relPath}`)
  }
  const segments = relPath.split('/')
  if ((segments[0] ?? '').startsWith('-')) {
    throw new VaultPathError(`Path cannot start with '-': ${relPath}`)
  }
  for (const seg of segments) {
    if (seg.startsWith('.')) {
      throw new VaultPathError(`Path targets a hidden (non-content) segment: ${relPath}`)
    }
  }
}
