import { Vault } from './vault.js'
import { WriteCore } from './write-core.js'
import { setFrontmatterKey } from './frontmatter.js'
import { atomicWrite, readFileOrNull } from './atomic.js'
import { writeTask, type Task } from './task.js'
import { deleteNote } from './delete.js'
import { ConflictError } from './errors.js'

/**
 * One unit of vault change the agent proposes. Every op is reversible (each
 * applies as its own git commit). The op set is deliberately small — Phase 3
 * only files captures, sets frontmatter, and closes loops.
 */
export type Op =
  | { kind: 'writeNote'; path: string; content: string; baseHash?: string | null }
  | { kind: 'writeTask'; task: Task; baseHash?: string | null }
  | { kind: 'setFrontmatter'; path: string; key: string; value: unknown; baseHash?: string | null }
  | { kind: 'deleteNote'; path: string; baseHash?: string | null }

/**
 * A proposal: the agent's "here's what I'd do and why" (DESIGN §4, §9). It NEVER
 * mutates the vault on its own — only `applyProposal` (called after a human
 * approves) does, and always as `author:'agent'`. `source` cites where it came
 * from (cite-source).
 */
export interface Proposal {
  id: string
  summary: string
  rationale: string
  source?: string
  ops: Op[]
}

export interface ApplyResult {
  proposalId: string
  commits: string[]
  applied: boolean
  /** The error that stopped application, when `applied` is false. */
  error?: Error
}

/**
 * Apply an approved proposal, executing each op IN ORDER as `author:'agent'`.
 *
 * CONCURRENCY (propose-time CAS): each op carries the `baseHash` stamped at
 * propose time (`stampProposalBases`), so a human edit made BETWEEN propose and
 * approve surfaces as a ConflictError at apply instead of being clobbered.
 * Ops WITHOUT a `baseHash` (legacy persisted proposals) fall back to reading
 * the file's CURRENT hash — last-writer-wins, git-reversible as before.
 *
 * PARTIAL-FAILURE CONTRACT (Phase 3 — simple + honest): ops apply in order; on
 * the FIRST failing op (e.g. a ConflictError because the file changed under us)
 * we STOP and return `{applied:false, commits:[...the ops that did commit...]}`.
 * We do NOT roll back the ops already applied — git history is the safety net
 * (each applied op is its own reversible commit, so a human can revert any of
 * them). A fully-applied proposal returns `{applied:true}` with one commit per
 * op. This keeps the engine trivial to reason about; rollback/transaction
 * semantics are a later phase, not Phase 3.
 */
export async function applyProposal(
  core: WriteCore,
  proposal: Proposal,
): Promise<ApplyResult> {
  const commits: string[] = []
  for (const op of proposal.ops) {
    try {
      commits.push(await applyOp(core, op))
    } catch (err) {
      // Stop on the first failing op. The ops that already committed STAY
      // applied (no rollback) — git history is how a human undoes any of them.
      return { proposalId: proposal.id, commits, applied: false, error: err as Error }
    }
  }
  return { proposalId: proposal.id, commits, applied: true }
}

/** The vault path an op targets (writeTask ops live at tasks/<id>.json). */
function opTarget(op: Op): string {
  return op.kind === 'writeTask' ? 'tasks/' + op.task.id + '.json' : op.path
}

/**
 * Stamp each op with the CURRENT content hash of its target (null = expect-create).
 * Called at propose time so a human edit made between propose and approve
 * surfaces as a ConflictError at apply instead of being clobbered.
 * Ops without baseHash (legacy persisted proposals) keep last-writer-wins.
 *
 * Assumes at most one op per target path per proposal — stamping uses the
 * current on-disk hash, so a second op on the same target would conflict with
 * the first op's own write.
 */
export async function stampProposalBases(core: WriteCore, proposals: Proposal[]): Promise<Proposal[]> {
  const out: Proposal[] = []
  for (const p of proposals) {
    const ops: Op[] = []
    for (const op of p.ops) {
      const current = await core.read(opTarget(op))
      ops.push({ ...op, baseHash: current?.hash ?? null })
    }
    out.push({ ...p, ops })
  }
  return out
}

/** Execute one op as the agent, returning its commit SHA. Throws on failure. */
async function applyOp(core: WriteCore, op: Op): Promise<string> {
  // Propose-time CAS: a stamped op must still match the on-disk state.
  // Unstamped (legacy) ops fall back to read-current = last-writer-wins.
  // ONE read serves every case: for unstamped ops it IS the base; for
  // setFrontmatter/deleteNote it is also the current state the base is
  // compared against (no second read).
  const current = await core.read(opTarget(op))
  const base = op.baseHash !== undefined ? op.baseHash : (current?.hash ?? null)
  switch (op.kind) {
    case 'writeNote':
      return (await core.write(op.path, op.content, { author: 'agent', baseHash: base })).commit
    case 'writeTask':
      return (await writeTask(core, op.task, 'agent', base)).commit
    case 'setFrontmatter': {
      if ((current?.hash ?? null) !== base)
        throw new ConflictError(op.path, base ?? '(new)', current?.hash ?? '(missing)')
      const next = setFrontmatterKey(current?.content ?? '', op.key, op.value)
      return (await core.write(op.path, next, { author: 'agent', baseHash: base })).commit
    }
    case 'deleteNote': {
      // Delete through the write-core: per-file lock + CAS + the shared git lock.
      // A stamped delete whose target changed between propose and approve (or
      // under a concurrent write) fails here instead of removing the newer
      // version; an unstamped (legacy) delete stays last-writer-wins. A MISSING
      // path is a partial failure (no rollback of ops already applied); a
      // traversal path throws via resolveSafe. Both halt the apply by design.
      const res = await deleteNote(core, op.path, op.baseHash)
      if (!res.ok) throw new Error(`deleteNote: path not found: ${op.path}`)
      return res.commit
    }
  }
}

/**
 * Where pending proposals live. This is APP STATE (what the brief/UI surfaces),
 * NOT vault prose — so it bypasses the WriteCore (no git provenance, no CAS) and
 * writes atomically straight to `.agentkeep/proposals.json`. `.agentkeep/` is the
 * app-state dir (DESIGN §7.7), not part of the markdown vault.
 */
const PENDING_REL = '.agentkeep/proposals.json'

export async function savePendingProposals(vault: Vault, proposals: Proposal[]): Promise<void> {
  await atomicWrite(vault.abs(PENDING_REL), JSON.stringify(proposals, null, 2) + '\n')
}

export async function loadPendingProposals(vault: Vault): Promise<Proposal[]> {
  const raw = await readFileOrNull(vault.abs(PENDING_REL))
  if (raw === null) return []
  return JSON.parse(raw) as Proposal[]
}

/** Remove one pending proposal by id (e.g. the human dismissed it). */
export async function dismissProposal(vault: Vault, id: string): Promise<void> {
  const remaining = (await loadPendingProposals(vault)).filter((p) => p.id !== id)
  await savePendingProposals(vault, remaining)
}
