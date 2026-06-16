import { readdir } from 'node:fs/promises'
import { Vault } from './vault.js'
import { WriteCore } from './write-core.js'
import { readFileOrNull } from './atomic.js'
import type { Author } from './git.js'

/**
 * A task: sharded JSON, one file per entity (DESIGN §7.1) — structured fields
 * markdown can't carry. Lives at `tasks/<id>.json`. `status` is the only kanban
 * dimension v1 needs; `inbox` is the unfiled default the agent assigns on filing.
 */
export interface Task {
  id: string
  title: string
  status: 'inbox' | 'today' | 'doing' | 'done'
  due?: string
  priority?: 'low' | 'med' | 'high'
  tags?: string[]
  created: string
  source?: string
  /**
   * Optional ISO timestamp recorded when the task moved to `done` (caller-set,
   * deterministic — never `Date.now()`). The Morning Brief prefers it over the
   * bare `status:'done'` snapshot to count loops closed within an overnight
   * window; absent, the brief counts all done tasks (see `generateBrief`).
   */
  closedAt?: string
  /**
   * Who closed the loop, recorded ONLY when the close actually happened (set at
   * the source — never inferred from `status:'done'` alone). The Morning Brief
   * uses this to attribute honestly: it claims "closed by your agent" only when
   * this is `'agent'`. Absent (legacy/unknown) or `'human'` ⇒ no agent claim.
   */
  closedBy?: 'agent' | 'human'
}

/** The sharded path for a task: one file per entity. */
export function taskPath(id: string): string {
  return 'tasks/' + id + '.json'
}

/**
 * Read a task by id, or null if it doesn't exist OR is unreadable. A corrupt
 * present shard returns null (not a throw), matching `listTasks`' skip-the-bad-
 * shard discipline so one malformed file can't break a caller mid-loop.
 */
export async function readTask(core: WriteCore, id: string): Promise<Task | null> {
  const r = await core.read(taskPath(id))
  if (r === null) return null
  try {
    return JSON.parse(r.content) as Task
  } catch {
    return null
  }
}

/**
 * Write a task through the WriteCore (same CAS + git provenance as prose). The
 * on-disk form is pretty JSON + a trailing newline so diffs are reviewable.
 * `baseHash` is the hash the caller read (null = expect-create); a stale hash
 * rejects with ConflictError, exactly like any other vault write.
 */
export async function writeTask(
  core: WriteCore,
  task: Task,
  author: Author,
  baseHash: string | null,
): Promise<{ hash: string; commit: string }> {
  const content = JSON.stringify(task, null, 2) + '\n'
  return core.write(taskPath(task.id), content, { author, baseHash })
}

/** Read every `tasks/*.json` in the vault. Skips unparseable shards. */
export async function listTasks(vault: Vault): Promise<Task[]> {
  let entries: string[]
  try {
    entries = await readdir(await vault.resolveSafe('tasks'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Task[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const raw = await readFileOrNull(await vault.resolveSafe('tasks/' + name))
    if (raw === null) continue
    try {
      out.push(JSON.parse(raw) as Task)
    } catch {
      // A malformed shard must not abort the whole listing (mirrors the
      // indexer's skip-the-bad-file discipline).
    }
  }
  return out
}
