import { Vault } from './vault.js'
import { WriteCore } from './write-core.js'
import { Indexer } from './indexer.js'
import { readNote } from './frontmatter.js'
import { listTasks } from './task.js'
import {
  applyProposal,
  savePendingProposals,
  loadPendingProposals,
  stampProposalBases,
  type ApplyResult,
  type Proposal,
} from './proposal.js'
import type { Maker } from './maker.js'

export interface AgentDeps {
  vault: Vault
  core: WriteCore
  indexer: Indexer
  maker: Maker
}

/** Read every `inbox/*.md` capture into `{path, text}` (frontmatter stripped). */
async function readInbox(deps: AgentDeps): Promise<{ path: string; text: string }[]> {
  const all = await deps.vault.listMarkdown()
  const inbox = all.filter((p) => p.startsWith('inbox/'))
  const out: { path: string; text: string }[] = []
  for (const path of inbox) {
    const r = await deps.core.read(path)
    if (r === null) continue
    out.push({ path, text: readNote(r.content).body.trim() })
  }
  return out
}

/**
 * Run the agent once (DESIGN §4.2): read the inbox + tasks, ask the maker to
 * PROPOSE, stamp each op with its target's propose-time baseHash, persist the
 * stamped proposals as pending, and return them. This NEVER mutates vault prose
 * or tasks — propose→approve means only `approve*` applies.
 */
export async function runAgentOnce(deps: AgentDeps): Promise<{ proposals: Proposal[] }> {
  const inbox = await readInbox(deps)
  const tasks = await listTasks(deps.vault)
  const proposals = await stampProposalBases(deps.core, await deps.maker.propose({ inbox, tasks }))
  await savePendingProposals(deps.vault, proposals)
  return { proposals }
}

/** Apply one proposal as the agent, then reindex and clear it from pending. */
async function applyAndClear(deps: AgentDeps, proposal: Proposal): Promise<ApplyResult> {
  const result = await applyProposal(deps.core, proposal)
  await deps.indexer.reindexAll()
  const remaining = (await loadPendingProposals(deps.vault)).filter((p) => p.id !== proposal.id)
  await savePendingProposals(deps.vault, remaining)
  return result
}

/** Approve + apply every proposal in order (human-at-the-helm bulk approve). */
export async function approveAll(deps: AgentDeps, proposals: Proposal[]): Promise<ApplyResult[]> {
  const results: ApplyResult[] = []
  for (const p of proposals) results.push(await applyAndClear(deps, p))
  return results
}

/** Approve + apply a single pending proposal by id. Throws if it isn't pending. */
export async function approve(deps: AgentDeps, proposalId: string): Promise<ApplyResult> {
  const pending = await loadPendingProposals(deps.vault)
  const proposal = pending.find((p) => p.id === proposalId)
  if (!proposal) throw new Error(`No pending proposal ${proposalId}`)
  return applyAndClear(deps, proposal)
}
