import { simpleGit, type SimpleGit } from 'simple-git'
import { Mutex } from 'async-mutex'

export type Author = 'human' | 'agent'
export interface CommitInfo { sha: string; message: string; authorName: string }
/** One agent-authored commit for the activity feed (newest-first). */
export interface AgentCommit {
  sha: string
  message: string
  /** Strict-ISO author date. */
  date: string
  /** The one path the commit touched, when it touched exactly one (else omitted). */
  path?: string
}
/** One entry of a note's per-path history (newest-first), author already mapped. */
export interface HistoryEntry { sha: string; author: Author; message: string; dateISO: string }

const IDENTITY: Record<Author, { name: string; email: string }> = {
  human: { name: 'agentkeep-human', email: 'human@agentkeep.local' },
  agent: { name: 'agentkeep-agent', email: 'agent@agentkeep.local' },
}

/**
 * Map a git author NAME back to the two-driver identity. The agent name is exact
 * (`agentkeep-agent`); anything else — including the baseline snapshot and a
 * human's reverts — counts as human, so we NEVER mislabel a non-agent commit as
 * the agent (the undo affordance keys off this, and must never offer to revert a
 * human's work). Returns null when there is no commit to classify.
 */
function authorFromName(name: string | undefined | null): Author | null {
  if (name == null) return null
  return name === IDENTITY.agent.name ? 'agent' : 'human'
}

/**
 * Env keys simple-git's safety guard refuses to pass through `.env()` (they map
 * to "unsafe" git config like editor/askpass/pager/ssh). Because `.env()`
 * REPLACES the child env, we forward process.env (so git keeps PATH/HOME/...)
 * but strip these — we never open an interactive editor or run those hooks
 * (commits always carry an inline message). This keeps commits working on hosts
 * where EDITOR/SSH_ASKPASS/etc. are set.
 */
const UNSAFE_ENV_KEYS = [
  'EDITOR', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'VISUAL',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PAGER', 'PAGER',
  'GIT_EXTERNAL_DIFF', 'GIT_PROXY_COMMAND', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
]

function commitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of UNSAFE_ENV_KEYS) delete env[key]
  return { ...env, ...extra }
}

export class VaultGit {
  private git: SimpleGit
  // Repo-wide lock: git stages into a single `.git/index` and updates one HEAD
  // ref, so concurrent stage+commit on DIFFERENT paths still collide on
  // `.git/index.lock` / `cannot lock ref 'HEAD'`. Serialize the git step (the
  // atomic file writes themselves stay parallel — only this critical section is
  // exclusive).
  private repoLock = new Mutex()
  constructor(private root: string) {
    this.git = simpleGit(root)
  }

  /** True if `root` is already inside a git work tree. */
  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo()
  }

  /** Init a repo if none exists (idempotent). Safe on an existing Obsidian vault. */
  async ensureRepo(): Promise<void> {
    if (!(await this.git.checkIsRepo())) {
      await this.git.init()
    }
  }

  /** Stage one path and commit it as `author`. Returns the commit SHA. */
  async commitChange(relPath: string, opts: { author: Author; message: string }): Promise<string> {
    const id = IDENTITY[opts.author]
    return this.repoLock.runExclusive(async () => {
      // `git add` is REQUIRED, not redundant: `git commit -- <pathspec>` only
      // commits files already KNOWN to git, so a brand-new (untracked) note
      // would fail with "pathspec did not match any file(s) known to git"
      // without staging it first. The commit pathspec then scopes the commit to
      // exactly this path (so a concurrent file staged by another caller's
      // `add` does not ride along on this commit).
      await this.git.add(relPath)
      const res = await this.git
        .env(commitEnv({ GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email }))
        .commit(opts.message, [relPath])
      return res.commit
    })
  }

  /**
   * Remove a tracked path from disk and commit the deletion as `author` (under
   * the repo-wide git lock). `git rm` both unlinks the working-tree file and
   * stages the removal, so the deletion is one reversible commit (git is the
   * undo). Returns the commit SHA. No-op-safe contract: caller checks existence
   * first; a `git rm` on an unknown path throws (surfaced to the caller).
   */
  async removePath(relPath: string, opts: { author: Author; message: string }): Promise<string> {
    const id = IDENTITY[opts.author]
    return this.repoLock.runExclusive(async () => {
      await this.git.rm(relPath)
      const res = await this.git
        .env(commitEnv({ GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email }))
        .commit(opts.message, [relPath])
      return res.commit
    })
  }

  /** Most recent commit touching a path, or null. */
  async lastCommit(relPath: string): Promise<CommitInfo | null> {
    const log = await this.git.log({ file: relPath, maxCount: 1 })
    const c = log.latest
    if (!c) return null
    return { sha: c.hash, message: c.message, authorName: c.author_name }
  }

  /**
   * The author (`agent`/`human`) of the most recent commit touching a path, or
   * null if the path is untracked (no commit has ever touched it). Maps the git
   * author name back to the two-driver identity — the agent badge in the editor
   * keys off this, so a non-agent commit is never reported as the agent's.
   */
  async lastAuthor(relPath: string): Promise<Author | null> {
    // `lastCommit` throws on a repo with NO commits yet (`branch does not have
    // any commits`); an untracked path on a non-empty repo returns null cleanly.
    // Treat both as "no author to report".
    let last: CommitInfo | null
    try {
      last = await this.lastCommit(relPath)
    } catch {
      return null
    }
    if (!last) return null
    return authorFromName(last.authorName)
  }

  /**
   * Recent commits touching `relPath`, newest first (capped at `limit`), with the
   * author already mapped to `agent`/`human` and an ISO author date. Powers the
   * note's History/Undo panel. An untracked path yields `[]`.
   */
  async noteHistory(relPath: string, limit = 10): Promise<HistoryEntry[]> {
    // `%aI` = strict-ISO author date; simple-git's log() carries name+message+hash
    // but not the date in a stable field, so request it explicitly here.
    let log
    try {
      log = await this.git.log({
        file: relPath,
        maxCount: limit,
        format: { sha: '%H', author: '%an', message: '%s', dateISO: '%aI' },
      })
    } catch {
      // A repo with NO commits yet (`branch does not have any commits`) — there
      // is no history to read. An untracked path on a non-empty repo already
      // returns an empty log; this only guards the truly-empty case.
      return []
    }
    return log.all.map((c) => ({
      sha: c.sha,
      author: authorFromName(c.author) ?? 'human',
      message: c.message,
      dateISO: c.dateISO,
    }))
  }

  /** HEAD commit (the most recent change to the vault), or null on an empty repo. */
  async headCommit(): Promise<CommitInfo | null> {
    const log = await this.git.log({ maxCount: 1 })
    const c = log.latest
    if (!c) return null
    return { sha: c.hash, message: c.message, authorName: c.author_name }
  }

  /**
   * The most recent commit authored by the agent (`agentkeep-agent`), or null if
   * the agent has never written. Used by the web "undo last" surface — it only
   * undoes the agent's latest change, never a human's, so an undo can't silently
   * clobber the human's own edit. Matches on the agent author email (stable;
   * names can be reconfigured).
   */
  async lastAgentCommit(): Promise<CommitInfo | null> {
    // `--author` filters by author; scoped to the agent identity's email.
    const log = await this.git.log(['--author=' + IDENTITY.agent.email, '--max-count=1'])
    const c = log.latest
    if (!c) return null
    return { sha: c.hash, message: c.message, authorName: c.author_name }
  }

  /**
   * The last `limit` commits authored by the agent (`agentkeep-agent`), newest
   * first — the "Recent agent activity" feed. One `git log --name-only` call;
   * the touched path rides along only when the commit touched exactly one file
   * (write-core commits are path-scoped, so that's the normal case) — a
   * multi-file commit honestly omits `path` rather than guessing. An empty repo
   * or an agent that never wrote yields `[]`.
   */
  async recentAgentCommits(limit: number): Promise<AgentCommit[]> {
    // Field separator %x1f (unit separator) can't appear in a subject line;
    // --name-only appends the touched paths after each header line.
    let raw: string
    try {
      raw = await this.git.raw([
        'log',
        '--author=' + IDENTITY.agent.email,
        '--max-count=' + String(limit),
        '--format=%H%x1f%aI%x1f%s',
        '--name-only',
      ])
    } catch {
      return [] // a repo with no commits yet
    }
    const commits: AgentCommit[] = []
    let files: string[] = []
    const flushFiles = () => {
      const last = commits[commits.length - 1]
      if (last && files.length === 1) last.path = files[0]
      files = []
    }
    for (const line of raw.split('\n')) {
      if (line.includes('\x1f')) {
        flushFiles()
        const [sha, date, message] = line.split('\x1f')
        commits.push({ sha: sha!, date: date!, message: message ?? '' })
      } else if (line.trim() !== '') {
        files.push(line.trim())
      }
    }
    flushFiles()
    return commits
  }

  /**
   * Revert one commit by SHA as the human (a new inverse commit — git history is
   * never rewritten, so the undo is itself reversible). `--no-edit` keeps it
   * non-interactive. Returns the new revert commit's SHA. Throws on a conflicted
   * revert (surfaced to the caller, which reports it rather than leaving the tree
   * mid-revert).
   */
  async revertCommit(sha: string): Promise<string> {
    const id = IDENTITY.human
    return this.repoLock.runExclusive(async () => {
      try {
        await this.git
          .env(commitEnv({ GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email }))
          .raw(['revert', '--no-edit', sha])
      } catch (err) {
        // A conflicting revert leaves the tree mid-merge; abort so the next
        // action starts clean, then re-throw for the caller to report.
        await this.git.raw(['revert', '--abort']).catch(() => {})
        throw err
      }
      const head = await this.headCommit()
      return head?.sha ?? sha
    })
  }

  /** Stage everything and commit a baseline snapshot (no-op if nothing to commit). */
  async snapshotAll(message: string): Promise<string | null> {
    await this.ensureRepo()
    return this.repoLock.runExclusive(async () => {
      await this.git.add('.')
      const status = await this.git.status()
      if (status.staged.length === 0 && status.files.length === 0) return null
      const id = IDENTITY.human
      const res = await this.git
        .env(commitEnv({ GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email }))
        .commit(message)
      return res.commit
    })
  }
}
