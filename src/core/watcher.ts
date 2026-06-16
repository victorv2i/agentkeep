import { watch, type FSWatcher } from 'chokidar'
import { sep } from 'node:path'
import { Vault } from './vault.js'
import { Indexer } from './indexer.js'
import { readFileOrNull } from './atomic.js'
import { contentHash } from './hash.js'

export type WatchEventKind = 'add' | 'change' | 'unlink'

export interface VaultWatcherOpts {
  /**
   * Self-write suppression hook. Given a vault-relative path and the content
   * hash just observed on disk, return true if this process already indexed that
   * exact write (the write-core indexes its own writes), so the watcher should
   * NOT reindex it again. Defaults to "never a self-write".
   */
  isSelfWrite?: (relPath: string, hash: string) => boolean
}

/**
 * Keeps an Indexer live by watching the vault with chokidar (atomic-aware,
 * await-write-finish), ignoring dotfolders and non-markdown. Self-writes from the
 * write-core are suppressed so a write never triggers a redundant reindex.
 *
 * The event-handling decision lives in `handleEvent`, which is pure with respect
 * to chokidar's timing (it reads the file + hashes it itself), so add/change/
 * unlink/suppression are unit-testable without a real watcher.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private readonly isSelfWrite: (relPath: string, hash: string) => boolean

  constructor(private vault: Vault, private indexer: Indexer, opts: VaultWatcherOpts = {}) {
    this.isSelfWrite = opts.isSelfWrite ?? (() => false)
  }

  /**
   * Handle one filesystem event. For add/change it reads the file, hashes it, and
   * skips the reindex if `isSelfWrite` claims this process just wrote it; unlink
   * always removes (the file is gone — nothing to hash, nothing to suppress).
   */
  async handleEvent(kind: WatchEventKind, relPath: string): Promise<void> {
    if (kind === 'unlink') {
      this.indexer.removeFile(relPath)
      return
    }
    const abs = await this.vault.resolveSafe(relPath)
    const raw = await readFileOrNull(abs)
    if (raw === null) {
      // Raced deletion between the event and our read — treat as removal.
      this.indexer.removeFile(relPath)
      return
    }
    if (this.isSelfWrite(relPath, contentHash(raw))) return // already indexed by the write-core
    await this.indexer.reindexFile(relPath)
  }

  /** Begin watching. Existing files are NOT re-emitted (use reindexAll first). */
  async start(): Promise<void> {
    if (this.watcher) return
    const w = watch('.', {
      cwd: this.vault.root,
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      // Ignore dotfolders (.git, .agentkeep, temp dirs) and any non-markdown file.
      ignored: (p, stats) => {
        const rel = toRel(p, this.vault.root)
        if (rel === '') return false // the watch root itself
        if (rel.split('/').some((seg) => seg.startsWith('.'))) return true
        // Only filter files by extension; never prune directories (they hold .md).
        if (stats?.isFile() && !rel.endsWith('.md')) return true
        return false
      },
    })
    const run = (kind: WatchEventKind) => (p: string) => {
      void this.handleEvent(kind, norm(p)).catch(() => {
        // A failed reindex must not crash the watcher; the next full reindexAll
        // (rebuildable-from-files) recovers any missed update.
      })
    }
    w.on('add', run('add'))
    w.on('change', run('change'))
    w.on('unlink', run('unlink'))
    await new Promise<void>((resolve, reject) => {
      w.once('ready', () => resolve())
      w.once('error', reject)
    })
    this.watcher = w
  }

  /** Stop watching and release resources. */
  async stop(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.close()
    this.watcher = null
  }
}

/** chokidar emits paths relative to `cwd`; normalize to POSIX separators. */
function norm(p: string): string {
  return p.split(sep).join('/')
}

/** Best-effort vault-relative POSIX path for the ignore matcher (absolute input). */
function toRel(p: string, root: string): string {
  let rel = p.startsWith(root) ? p.slice(root.length) : p
  if (rel.startsWith(sep) || rel.startsWith('/')) rel = rel.slice(1)
  return rel.split(sep).join('/')
}
