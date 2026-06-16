import { WriteCore } from './write-core.js'

/**
 * Result of a delete attempt. Like the read path, "not found" is a VALUE
 * (`{ok:false}`), not a throw — a caller deleting an already-gone path (e.g. a
 * re-run that re-files the same inbox capture) is a no-op, not an error. A path
 * that escapes the vault DOES throw (VaultPathError, via `resolveSafe`) — that's
 * a guard violation, not a benign miss.
 */
export type DeleteResult = { ok: true; commit: string } | { ok: false }

/**
 * Remove one vault note as the agent. A thin wrapper over `WriteCore.delete` so
 * the deletion shares the write path's per-file mutex + content-hash CAS + the
 * single git instance (one repo lock): a delete can neither race a concurrent
 * write to the same path nor clobber an edit, and a propose-time `baseHash`
 * (when stamped) is enforced under the lock. A missing path is `{ok:false}`; a
 * path that escapes the vault throws VaultPathError (via `resolveSafe`). The
 * removal is one agent commit, git-reversible like any change. Index upkeep is
 * the caller's job (the MCP handler calls `indexer.removeFile`).
 */
export async function deleteNote(
  core: WriteCore,
  relPath: string,
  baseHash?: string | null,
): Promise<DeleteResult> {
  return core.delete(relPath, { author: 'agent', baseHash })
}
