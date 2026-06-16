import { Mutex } from 'async-mutex'
import { Vault, assertVaultContentPath } from './vault.js'
import { VaultGit, type Author } from './git.js'
import { contentHash } from './hash.js'
import { atomicWrite, readFileOrNull } from './atomic.js'
import { ConflictError } from './errors.js'

export interface ReadResult { content: string; hash: string }
export interface WriteOpts { author: Author; baseHash: string | null }
export interface WriteResult { hash: string; commit: string }

/**
 * The ONLY writer of the vault. Every mutation:
 *   per-file mutex → symlink-safe path resolution → content-hash
 *   compare-and-swap → atomic write → git commit (under a repo-wide git lock).
 * `baseHash` is the hash the caller read before editing: null = expect-create,
 * string = expect that exact current content (else ConflictError / 409).
 *
 * Write contract: the file is written atomically (temp + fsync + rename), THEN
 * committed under the repo-wide git lock. The self-write marker is set only
 * AFTER the commit succeeds. On a genuine git failure the error surfaces and the
 * on-disk content is the attempted write — recoverable by the next snapshot —
 * but the write is NOT marked as a self-write. We do not roll back the disk:
 * serializing commits (the repo-wide git lock) removes the common failure, which
 * is sufficient for Phase 1.
 */
export class WriteCore {
  // TODO(phase2): evict idle per-path mutexes (this map grows once per path).
  private locks = new Map<string, Mutex>()
  private selfWrites = new Map<string, string>()

  constructor(private vault: Vault, private git: VaultGit) {}

  private lockFor(relPath: string): Mutex {
    let m = this.locks.get(relPath)
    if (!m) { m = new Mutex(); this.locks.set(relPath, m) }
    return m
  }

  async read(relPath: string): Promise<ReadResult | null> {
    const content = await readFileOrNull(await this.vault.resolveSafe(relPath))
    if (content === null) return null
    return { content, hash: contentHash(content) }
  }

  async write(relPath: string, content: string, opts: WriteOpts): Promise<WriteResult> {
    assertVaultContentPath(relPath) // never let a write target .git/ etc. (RCE)
    const abs = await this.vault.resolveSafe(relPath)
    return this.lockFor(relPath).runExclusive(async () => {
      const current = await readFileOrNull(abs)
      const currentHash = current === null ? null : contentHash(current)
      if (currentHash !== opts.baseHash) {
        throw new ConflictError(relPath, opts.baseHash ?? '(new)', currentHash ?? '(missing)')
      }
      await atomicWrite(abs, content)
      const hash = contentHash(content)
      const commit = await this.git.commitChange(relPath, { author: opts.author, message: `${opts.author}: write ${relPath}` })
      // Only mark a self-write once the commit succeeds (I1): a failed commit
      // must not suppress a later watcher event for this path.
      this.selfWrites.set(relPath, hash)
      return { hash, commit }
    })
  }

  /**
   * Delete a note through the SAME per-file lock + CAS as write(), so a delete
   * can never race a concurrent write to the path nor silently clobber an edit.
   * A missing file is a no-op value (`{ok:false}`) like the read path. When
   * `baseHash` is a string the current content must still match it (else
   * ConflictError) — a delete proposed against one version won't remove a newer
   * one. `baseHash` undefined/null skips the CAS (still locked, last-writer-wins)
   * for callers with no base, e.g. clearing a freshly-filed inbox capture.
   */
  async delete(
    relPath: string,
    opts: { author: Author; baseHash?: string | null },
  ): Promise<{ ok: true; commit: string } | { ok: false }> {
    assertVaultContentPath(relPath) // never let a delete target .git/ etc.
    const abs = await this.vault.resolveSafe(relPath)
    return this.lockFor(relPath).runExclusive(async () => {
      const current = await readFileOrNull(abs)
      if (current === null) return { ok: false }
      if (typeof opts.baseHash === 'string' && contentHash(current) !== opts.baseHash) {
        throw new ConflictError(relPath, opts.baseHash, contentHash(current))
      }
      const commit = await this.git.removePath(relPath, {
        author: opts.author,
        message: `${opts.author}: delete ${relPath}`,
      })
      return { ok: true, commit }
    })
  }

  // isSelfWrite keeps only the LATEST hash per path. A Phase-2 watcher that can
  // observe several rapid self-writes before draining may need a small per-path
  // set instead of a single value.
  /** True if `hash` is the content this core most recently wrote to `relPath`. */
  isSelfWrite(relPath: string, hash: string): boolean {
    return this.selfWrites.get(relPath) === hash
  }
}
