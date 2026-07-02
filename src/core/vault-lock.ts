import lockfile from 'proper-lockfile'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Cross-PROCESS backstop around the write+git critical section (DESIGN §"coarse
 * backstop"). `write-core.ts`'s per-file `async-mutex` and `git.ts`'s repo-wide
 * mutex are per-INSTANCE: the web app and the MCP server each `openVault` a
 * SEPARATE `VaultGit`/`WriteCore` in a separate process, so two processes can
 * both pass the same in-memory checks and both write. `proper-lockfile` takes an
 * flock-style lock on a real file on disk, so it is visible across processes.
 *
 * Locked on a single file inside `.git/` (never `.agentkeep/`): the git step
 * these fixes protect (`git add` + `git commit`) already serializes across ALL
 * paths within one process (`VaultGit`'s `repoLock`), so a repo-wide cross-
 * process lock matches that granularity exactly — finer-grained (per-path)
 * cross-process locking would still collide on the shared `.git/index`. It lives
 * under `.git/` (git itself never tracks its own directory) rather than
 * `.agentkeep/` so the lock file never shows up as a dirty/untracked path in
 * `git status` — the mutation-time git-state preflight (fix 2) treats any
 * unexpected dirty path as unsafe, and the lock file is neither vault content
 * nor something that preflight should ever see.
 */
const LOCK_FILE_NAME = 'agentkeep-vault.lock'

// `proper-lockfile` requires the target file to exist before it will lock it.
async function ensureLockTarget(root: string): Promise<string> {
  const target = join(root, '.git', LOCK_FILE_NAME)
  await mkdir(join(root, '.git'), { recursive: true })
  try {
    await lockfile.check(target)
  } catch {
    // ENOENT: create an empty marker file for the lock to attach to.
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(target, '', { flag: 'a' })
  return target
}

/**
 * Run `fn` with the cross-process vault lock held, keyed on `vaultRoot`.
 * Stale locks (a crashed process never released) are reclaimed after 10s;
 * a contended lock is retried with backoff for up to ~5s before giving up.
 */
export async function withVaultLock<T>(vaultRoot: string, fn: () => Promise<T>): Promise<T> {
  const target = await ensureLockTarget(vaultRoot)
  const release = await lockfile.lock(target, {
    stale: 10_000,
    retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 300 },
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}
