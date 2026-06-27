'use server'

// Server action = the only bridge from the Settings UI to switching the live
// vault. The core (fs + git) never reaches the browser: validating the folder,
// opening it (git-init + .gitignore guard), persisting it, stopping the old
// watcher, and clearing the memo all run on the server in `setActiveVault`. We
// revalidate every surface so the whole app re-renders against the new vault.

import { revalidatePath } from 'next/cache'
import {
  preflightActiveVault,
  setActiveVault,
  type SetVaultResult,
  type VaultPreflightResult,
} from '@/lib/vault'

export type { VaultPreflightResult }

/** Read-only validation + side-effect preview before opening a vault folder. */
export async function preflightVaultAction(path: string): Promise<VaultPreflightResult> {
  return preflightActiveVault(path)
}

/** Open / switch to the vault folder at `path`, then refresh the whole app. */
export async function setActiveVaultAction(path: string): Promise<SetVaultResult> {
  const result = await setActiveVault(path)
  if (result.ok) {
    // The vault root changed under everything — revalidate all served surfaces so
    // the brief, notes, search, and settings re-read from the new vault.
    revalidatePath('/', 'layout')
  }
  return result
}
