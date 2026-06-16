import 'server-only'

import path from 'node:path'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

/**
 * Per-machine web state: which vault is currently open, plus the recently-opened
 * vaults for the quick-switch UI. This is NOT vault content and NOT source — it
 * lives OUTSIDE any vault, at `<repo>/.agentkeep-web-state.json` (one level above
 * `web/`), and is gitignored. A self-hosted single-user app: one state file per
 * checkout.
 *
 * When no state file exists, the app behaves exactly as before — `getVault()`
 * falls back to `AGENTKEEP_VAULT` then `./dev-vault`. Opening a vault from the UI
 * is what first creates this file.
 */

export interface VaultState {
  /** Absolute path of the vault the app is currently serving (if chosen in-UI). */
  activeVault: string | null
  /** Most-recently-opened vault paths, newest first, capped + deduped. */
  recentVaults: string[]
}

const EMPTY_STATE: VaultState = { activeVault: null, recentVaults: [] }
const MAX_RECENTS = 5

/** Absolute path to the state file: `<repo>/.agentkeep-web-state.json`. */
export function stateFilePath(): string {
  // cwd is the `web/` dir when Next runs; the repo root is one level up.
  return path.resolve(process.cwd(), '..', '.agentkeep-web-state.json')
}

/** Read the persisted state, or the empty default if the file is absent/corrupt. */
export async function readVaultState(): Promise<VaultState> {
  try {
    const raw = await readFile(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<VaultState>
    const activeVault =
      typeof parsed.activeVault === 'string' && parsed.activeVault.trim() !== ''
        ? parsed.activeVault
        : null
    const recentVaults = Array.isArray(parsed.recentVaults)
      ? parsed.recentVaults.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : []
    return { activeVault, recentVaults }
  } catch {
    // Missing file (ENOENT) or unparseable JSON → behave as if unset (the env/
    // dev-vault fallback applies). Never let a bad state file brick the app.
    return { ...EMPTY_STATE }
  }
}

/**
 * Set the active vault and push it to the front of recents (deduped, capped).
 *
 * `previous` is the vault we're switching AWAY from (the one currently being
 * served, possibly the env/dev-vault default that was never explicitly opened).
 * Folding it into recents is what makes it a one-click way back — otherwise a
 * vault reached only via the default fallback would never appear in recents.
 *
 * Written atomically (temp + rename) so a crash mid-write can't leave a partial
 * JSON that would then be silently ignored as "corrupt".
 */
export async function writeActiveVault(
  absPath: string,
  previous?: string | null,
): Promise<VaultState> {
  const prev = await readVaultState()
  // New active first; then the vault we left (if distinct); then prior recents.
  // Dedup keeps the newest position of any path; cap to MAX_RECENTS.
  const ordered = [
    absPath,
    ...(previous && previous !== absPath ? [previous] : []),
    ...prev.recentVaults,
  ]
  const seen = new Set<string>()
  const recentVaults = ordered.filter((p) => (seen.has(p) ? false : (seen.add(p), true))).slice(
    0,
    MAX_RECENTS,
  )
  const next: VaultState = { activeVault: absPath, recentVaults }
  const file = stateFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return next
}
