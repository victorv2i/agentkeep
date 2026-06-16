import { Vault } from './vault.js'
import { VaultGit } from './git.js'
import { WriteCore } from './write-core.js'
import { atomicWrite, readFileOrNull } from './atomic.js'

export { Vault } from './vault.js'
export { VaultGit, type Author, type CommitInfo, type HistoryEntry, type AgentCommit } from './git.js'
export { WriteCore, type ReadResult, type WriteResult, type WriteOpts } from './write-core.js'
export { ConflictError, ValidationError, VaultPathError } from './errors.js'
export { contentHash } from './hash.js'
export { readNote, setFrontmatterKey, type ParsedNote } from './frontmatter.js'
export { parseNote, type NoteMeta } from './parse.js'
export { displayTitle, isCaptureBasename, type DisplayTitleOpts } from './display-title.js'
export { LinkGraph } from './link-graph.js'
export { SearchIndex, type SearchHit } from './search-index.js'
export { Indexer } from './indexer.js'
export { VaultWatcher, type VaultWatcherOpts, type WatchEventKind } from './watcher.js'
export { newId } from './ids.js'
export { captureToInbox, type CaptureOpts, type CaptureResult } from './capture.js'
export { deleteNote, type DeleteResult } from './delete.js'
export { taskPath, readTask, writeTask, listTasks, type Task } from './task.js'
export {
  applyProposal,
  savePendingProposals,
  loadPendingProposals,
  dismissProposal,
  stampProposalBases,
  type Op,
  type Proposal,
  type ApplyResult,
} from './proposal.js'
export { MockMaker, getMaker, type Maker, type MakerInput } from './maker.js'
export { runAgentOnce, approveAll, approve, type AgentDeps } from './agent-loop.js'
export { readNorthStar, type Goal } from './north-star.js'
export {
  generateBrief,
  renderBrief,
  runMorningBrief,
  type BriefData,
  type BriefDeps,
  type Connection,
  type WhatMatters,
} from './brief.js'
export {
  createVaultTools,
  type VaultTool,
  type VaultToolsDeps,
  type ToolResult,
} from './vault-tools.js'

export interface Agentkeep {
  vault: Vault
  git: VaultGit
  core: WriteCore
  list: () => Promise<string[]>
}

/**
 * Default root `.gitignore` written ONLY when opening a folder that isn't already
 * a git repo (a fresh init). Keeps an existing Obsidian vault's private config
 * (`.obsidian/`, `.trash/`) and the app's rebuildable index cache
 * (`.agentkeep/cache/`) out of the baseline snapshot — opening your vault must
 * never silently commit your workspace layout, plugin data, or trash. Note that
 * `.agentkeep/config.json` stays TRACKED: only `.agentkeep/cache/` is ignored, so
 * the app-state marker is versioned while the disposable index is not.
 */
const DEFAULT_GITIGNORE =
  [
    '# Written by agentkeep when it first opened this vault as a git repo.',
    '# Keeps your Obsidian config and the rebuildable index out of version control.',
    '.obsidian/',
    '.trash/',
    '.agentkeep/cache/',
    '.agentkeep/index*',
  ].join('\n') + '\n'

/**
 * Open a vault (fresh OR an existing Obsidian vault): ensure a git repo, write
 * the `.agentkeep/config.json` app-state marker if absent, and take a baseline
 * snapshot so every later agent/human write is reversible. Never clobbers
 * existing files (only creates `.agentkeep/` if missing).
 *
 * On a FRESH git init (the folder wasn't already a repo) we first write a default
 * root `.gitignore` — but only if the folder has none — so the baseline snapshot
 * doesn't sweep in `.obsidian/` / `.trash/`. An existing `.gitignore` is left
 * exactly as the user wrote it (we honor their rules, never append).
 */
export async function openVault(root: string): Promise<Agentkeep> {
  const vault = new Vault(root)
  const git = new VaultGit(vault.root)
  // Decide BEFORE ensureRepo: a folder that isn't yet a git repo is a fresh init,
  // so this is the moment to lay down the default ignore (before the baseline
  // `git add .`). An already-tracked vault keeps whatever ignore rules it has.
  const freshInit = !(await git.isRepo())
  await git.ensureRepo()
  if (freshInit) {
    const rootIgnore = vault.abs('.gitignore')
    if ((await readFileOrNull(rootIgnore)) === null) {
      await atomicWrite(rootIgnore, DEFAULT_GITIGNORE)
    }
  }
  const cfg = vault.abs('.agentkeep/config.json')
  if ((await readFileOrNull(cfg)) === null) {
    await atomicWrite(cfg, JSON.stringify({ version: 1 }, null, 2) + '\n')
  }
  // Keep the rebuildable Phase-2 index cache out of git, while config.json stays
  // tracked. Written into `.agentkeep/` so the ignore is scoped to that folder.
  const ignore = vault.abs('.agentkeep/.gitignore')
  if ((await readFileOrNull(ignore)) === null) {
    await atomicWrite(ignore, 'cache/\nindex*\n')
  }
  await git.snapshotAll('baseline: agentkeep opened vault')
  const core = new WriteCore(vault, git)
  return { vault, git, core, list: () => vault.listMarkdown() }
}
