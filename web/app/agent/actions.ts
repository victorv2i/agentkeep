'use server'

// Server actions = the bridge from the client shell to the core. The core (fs +
// git) never reaches the browser; the capture runs here and funnels through the
// same WriteCore/VaultGit the editor uses, then revalidates the vault home.

import { revalidatePath } from 'next/cache'
import { captureToVault } from '@/lib/vault'

/** Capture raw text into the inbox as the human; your agent files it from there. */
export async function captureTextAction(
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await captureToVault(text)
  if ('error' in result) return { ok: false, error: result.error }
  revalidatePath('/')
  return { ok: true }
}
