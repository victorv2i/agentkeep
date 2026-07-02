import { Mutex } from 'async-mutex'
import { rm } from 'node:fs/promises'
import { Vault, assertVaultContentPath } from './vault.js'
import { VaultGit, type Author } from './git.js'
import { contentHash } from './hash.js'
import { atomicWrite, readFileOrNull } from './atomic.js'
import { ConflictError } from './errors.js'
import { withVaultLock } from './vault-lock.js'

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
 * committed under the repo-wide git lock. If git add/commit fails, we restore
 * the exact previous bytes (or remove the newly-created file) and clear any
 * staged entry for the path before rethrowing. The self-write marker is set only
 * AFTER the commit succeeds.
 *
 * Cross-process safety: the per-file mutex above is per-INSTANCE — a SEPARATE
 * process (the web app and the MCP server each open their own vault handle)
 * has its own mutex map and would not see this one. So the whole read-CAS-
 * write-git critical section ALSO runs under `withVaultLock` (a `proper-lockfile`
 * flock keyed on the vault root, visible across processes). The in-process mutex
 * stays as a cheap fast-path (avoids taking the cross-process lock for writers
 * that are already serialized in this process); the cross-process lock is what
 * actually prevents two processes from both passing the same baseHash CAS. The
 * current on-disk hash is RE-READ and RE-CHECKED against `baseHash` once inside
 * the lock, so a write that lost the cross-process race gets a ConflictError
 * instead of clobbering the winner.
 */
export class WriteCore {
  // TODO(phase2): evict idle per-path mutexes (this map grows once per path).
  private locks = new Map<string, Mutex>()
  private selfWrites = new Map<string, string>()

  constructor(private vault: Vault, private git: VaultGit) {}

  // Key the mutex on the RESOLVED absolute path, never the raw caller string:
  // two aliases of one physical file (`a/n.md` vs `a//n.md`, a trailing slash,
  // ...) produce different raw strings but the SAME abs, so a raw-keyed lock
  // would hand them different mutexes and both could pass the content-hash CAS
  // and both commit (a silently lost update with no 409). Locking on the abs
  // makes the whole read, CAS, atomic-write, commit critical section mutually
  // exclusive across every alias of the same file.
  private lockFor(abs: string): Mutex {
    let m = this.locks.get(abs)
    if (!m) { m = new Mutex(); this.locks.set(abs, m) }
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
    return this.lockFor(abs).runExclusive(() =>
      withVaultLock(this.vault.root, async () => {
        const current = await readFileOrNull(abs)
        const currentHash = current === null ? null : contentHash(current)
        if (currentHash !== opts.baseHash) {
          throw new ConflictError(relPath, opts.baseHash ?? '(new)', currentHash ?? '(missing)')
        }
        try {
          await atomicWrite(abs, content)
          const hash = contentHash(content)
          const commit = await this.git.commitChange(relPath, { author: opts.author, message: `${opts.author}: write ${relPath}` })
          // Only mark a self-write once the commit succeeds (I1): a failed commit
          // must not suppress a later watcher event for this path.
          this.selfWrites.set(relPath, hash)
          return { hash, commit }
        } catch (err) {
          await this.restoreAfterFailedWrite(abs, relPath, current)
          throw err
        }
      }),
    )
  }

  /**
   * Delete a note through the SAME per-file lock (keyed on the resolved abs) +
   * CAS as write(), so a delete can never race a concurrent write to the path
   * nor silently clobber an edit. A missing file is a no-op value (`{ok:false}`)
   * like the read path. When `baseHash` is a string the current content must
   * still match it (else ConflictError) — a delete proposed against one version
   * won't remove a newer one. `baseHash` undefined/null skips the CAS (still
   * locked, last-writer-wins) for callers with no base, e.g. clearing a
   * freshly-filed inbox capture.
   *
   * Delete contract (mirrors the write-side comment above): `git rm` unlinks the
   * working file AND stages the removal before the commit step. If that commit
   * step throws (a pre-commit hook rejects, disk full, ref locked), we atomically
   * re-write the file from the exact bytes read under this lock and clear the
   * staged deletion before re-throwing, so disk and index both return to the
   * pre-delete state.
   */
  async delete(
    relPath: string,
    opts: { author: Author; baseHash?: string | null },
  ): Promise<{ ok: true; commit: string } | { ok: false }> {
    assertVaultContentPath(relPath) // never let a delete target .git/ etc.
    const abs = await this.vault.resolveSafe(relPath)
    return this.lockFor(abs).runExclusive(() =>
      withVaultLock(this.vault.root, async () => {
        const current = await readFileOrNull(abs)
        if (current === null) return { ok: false }
        if (typeof opts.baseHash === 'string' && contentHash(current) !== opts.baseHash) {
          throw new ConflictError(relPath, opts.baseHash, contentHash(current))
        }
        try {
          const commit = await this.git.removePath(relPath, {
            author: opts.author,
            message: `${opts.author}: delete ${relPath}`,
          })
          return { ok: true, commit }
        } catch (err) {
          // The removal unlinked the working file but the commit failed. Re-write
          // the file from the exact bytes we read under this lock so it is not left
          // gone-from-disk, and unstage the removal. Best-effort: a failure to
          // restore must not mask the original commit error.
          await atomicWrite(abs, current).catch(() => {})
          await this.git.unstagePath(relPath).catch(() => {})
          throw err
        }
      }),
    )
  }

  /** True once if `hash` is the content this core most recently wrote to `relPath`. */
  isSelfWrite(relPath: string, hash: string): boolean {
    const marked = this.selfWrites.get(relPath)
    if (marked === undefined) return false
    this.selfWrites.delete(relPath)
    return marked === hash
  }

  private async restoreAfterFailedWrite(abs: string, relPath: string, previous: string | null): Promise<void> {
    if (previous === null) await rm(abs, { force: true }).catch(() => {})
    else await atomicWrite(abs, previous).catch(() => {})
    await this.git.unstagePath(relPath).catch(() => {})
  }
}
